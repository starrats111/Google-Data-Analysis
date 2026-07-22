import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { serializeData } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { verifyHermesToken } from "@/lib/hermes-auth";
import { publishArticleToSite } from "@/lib/remote-publisher";
import { runHumanizerGate, describeGateViolations } from "@/lib/humanizer-gate";
import { humanize } from "@/lib/humanizer";

// HM-D23：Hermes 委托发文 —— 接收 Hermes 生成好的完整文章，走 CRM 既有发布链路推到宝塔
// 链路与站内发布完全一致：Humanizer 门禁（不过检自动清洗一次，仍不过拒发 422）
// → articles 落库 → publishArticleToSite（SSH 宝塔 + 图片下载本地化 /images/articles/*.webp + 索引/静态页）。

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const authErr = verifyHermesToken(req);
  if (authErr) return authErr;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return apiError("请求体解析失败", 400);
  }

  const {
    site_id, title, content, category, merchant_name, tracking_link,
    excerpt, meta_title, meta_description, keywords, publish_time,
  } = body as {
    site_id?: string | number;
    title?: string;
    content?: string;
    category?: string;
    merchant_name?: string;
    tracking_link?: string;
    excerpt?: string;
    meta_title?: string;
    meta_description?: string;
    keywords?: string[];
    publish_time?: string;
  };

  if (!site_id || !title || !content) return apiError("site_id / title / content 必填");
  if (content.trim().length < 500) return apiError("正文过短（<500 字符），拒绝发布");

  // 配图硬校验（07 规格 2026-07-22）：正文必须内嵌 5-8 张 <img>
  const imgCount = [...content.matchAll(/<img\s[^>]*?src=["'][^"']+["']/gi)].length;
  if (imgCount < 5 || imgCount > 8) {
    return apiError(`正文配图 ${imgCount} 张，要求 5-8 张（含 hero 图）`, 422);
  }

  try {
    // Humanizer 门禁（与站内 publish-to-site 同规则）
    let contentForPublish = content;
    let gate = runHumanizerGate(contentForPublish);
    if (!gate.passed) {
      const cleaned = humanize(contentForPublish);
      const gateAfterClean = runHumanizerGate(cleaned);
      if (gateAfterClean.passed && cleaned.trim().length >= 200) {
        console.warn(`[HermesPublish] Humanizer 首检未通过（${describeGateViolations(gate)}），自动清洗后通过`);
        contentForPublish = cleaned;
        gate = gateAfterClean;
      } else {
        return apiError(
          `Humanizer 检测未通过，禁止发布：${describeGateViolations(gateAfterClean.passed ? gate : gateAfterClean)}`,
          422,
        );
      }
    }

    const site = await prisma.publish_sites.findFirst({
      where: { id: BigInt(site_id), is_deleted: 0, status: "active" },
    });
    if (!site) return apiError("站点不存在或未启用", 404);
    if (!site.site_path || !site.domain) return apiError("站点路径或域名未配置");

    // 文章归属账号：HERMES_ARTICLE_USERNAME（默认 wj07），在 CRM 文章列表可见可管理
    const ownerUsername = process.env.HERMES_ARTICLE_USERNAME || "wj07";
    const owner = await prisma.users.findFirst({
      where: { username: ownerUsername, is_deleted: 0 },
      select: { id: true },
    });
    if (!owner) return apiError(`文章归属账号 ${ownerUsername} 不存在`, 500);

    const slug = title
      .toLowerCase().trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/[\s_-]+/g, "-")
      .replace(/^-+|-+$/g, "");

    // 同站点同 slug 已发布则拒绝（防重复发布覆盖）
    const dup = await prisma.articles.findFirst({
      where: { publish_site_id: BigInt(site_id), slug, status: "published", is_deleted: 0 },
      select: { id: true },
    });
    if (dup) return apiError(`站点已有同 slug 文章（article_id=${dup.id}），换标题重试`, 409);

    const publishDate = publish_time ? new Date(publish_time) : new Date();
    const resolvedDate = isNaN(publishDate.getTime()) ? new Date() : publishDate;

    const article = await prisma.articles.create({
      data: {
        user_id: owner.id,
        publish_site_id: BigInt(site_id),
        title,
        slug,
        content: contentForPublish,
        excerpt: excerpt || null,
        meta_title: meta_title || null,
        meta_description: meta_description || null,
        keywords: keywords && keywords.length > 0 ? keywords : undefined,
        category: category || "General",
        merchant_name: merchant_name || null,
        tracking_link: tracking_link || null,
        status: "preview",
      },
    });

    const result = await publishArticleToSite(
      {
        id: String(article.id),
        title,
        slug,
        content: contentForPublish,
        category: category || "General",
        trackingLink: tracking_link || null,
      },
      {
        site_path: site.site_path,
        site_type: site.site_type,
        data_js_path: site.data_js_path,
        article_var_name: site.article_var_name,
        article_html_pattern: site.article_html_pattern,
        domain: site.domain,
      },
      resolvedDate,
    );

    if (!result.success) {
      await prisma.articles.update({
        where: { id: article.id },
        data: { status: "failed" },
      });
      return apiError(`发布失败: ${result.error}`, 500);
    }

    // 统计本地化后的图片数（/images/articles/），回给 Hermes 报告用
    const finalContent = result.updatedContent || contentForPublish;
    const localizedCount = [...finalContent.matchAll(/\/images\/articles\/[^"']+/g)].length;

    await prisma.articles.update({
      where: { id: article.id },
      data: {
        status: "published",
        published_at: resolvedDate,
        published_url: result.url || null,
        content: finalContent,
      },
    });

    return apiSuccess(serializeData({
      article_id: article.id,
      url: result.url,
      images_embedded: imgCount,
      images_localized: localizedCount,
    }), "发布成功");
  } catch (err) {
    console.error("[HermesPublish] POST 异常:", err);
    return apiError(`发布异常: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
}
