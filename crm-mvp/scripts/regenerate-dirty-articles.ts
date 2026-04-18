/**
 * 批量重生成含 reasoning 残留（<think>/<thinking>/<scratchpad>）的脏文章
 *
 * 背景（C-028）：DeepSeek-R1 / Gemini Thinking 类推理模型偶发把 reasoning 塞进 JSON
 * 的 content 字段，老版 sanitize 白名单只剥标签保留内部文本，导致 **Defining the Scope**
 * 类 reasoning 字符泄漏到前端预览 + 已发布外站。此脚本用修复后的 generateMerchantArticle
 * 逐篇重跑生成，保留原 title/slug/publish_site_id，对 published 文章重推外站覆盖。
 *
 * 使用：
 *   npx tsx scripts/regenerate-dirty-articles.ts --dry-run             # 只打印计划
 *   npx tsx scripts/regenerate-dirty-articles.ts --only-id=1203        # 只跑指定一篇（dry-run 后的真跑）
 *   npx tsx scripts/regenerate-dirty-articles.ts --include-deleted     # 连带处理已作废（is_deleted=1）的污染篇（07 Q2：处理后自动恢复 preview）
 *   npx tsx scripts/regenerate-dirty-articles.ts                       # 批量重跑全部未删除污染篇
 *
 * 默认行为：
 * - 保留原 title / slug / publish_site_id / tracking_link（外站 URL 不变）
 * - 只覆盖 content / excerpt / meta_title / meta_description / category
 * - status=published 的自动重推外站；其它状态只更新 DB
 * - 已作废（is_deleted=1）的篇处理完后自动恢复：is_deleted=0, status=preview（07 Q2 指示）
 * - 每篇间隔 5s，任一篇失败立即停止（不带 --keep-going）
 */

import prisma from "../src/lib/prisma";
import { analyzeUrl, generateMerchantArticle } from "../src/lib/article-gen";
import { publishArticleToSite, verifyConnection } from "../src/lib/remote-publisher";

const IS_DRY_RUN = process.argv.includes("--dry-run");
const INCLUDE_DELETED = process.argv.includes("--include-deleted");
const KEEP_GOING = process.argv.includes("--keep-going");
const ONLY_ID = (() => {
  const arg = process.argv.find((a) => a.startsWith("--only-id="));
  return arg ? BigInt(arg.split("=")[1]) : null;
})();
const SLEEP_BETWEEN_MS = 5000;

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function ok(msg: string) {
  console.log(`[${new Date().toISOString()}] ✓ ${msg}`);
}

function fail(msg: string) {
  console.error(`[${new Date().toISOString()}] ✗ ${msg}`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isDirty(content: string | null): boolean {
  if (!content) return false;
  return /<(?:think|thinking|scratchpad|reasoning|reflection|analysis|plan)\b/i.test(content);
}

async function ensureVerifiedSite(siteId: bigint) {
  const site = await prisma.publish_sites.findFirst({
    where: { id: siteId, is_deleted: 0, status: "active" },
  });
  if (!site || !site.site_path || !site.domain) return null;

  const checks = await verifyConnection(site.site_path);
  if (!checks.valid) return null;

  return {
    site_path: site.site_path,
    site_type: checks.site_type ?? site.site_type ?? null,
    data_js_path: checks.data_js_path ?? site.data_js_path ?? null,
    article_var_name: checks.article_var_name ?? site.article_var_name ?? null,
    article_html_pattern: checks.article_html_pattern ?? site.article_html_pattern ?? null,
    domain: site.domain,
  };
}

async function main() {
  log(`模式: ${IS_DRY_RUN ? "DRY-RUN（不写 DB/不推外站）" : "REAL-RUN"}`);
  log(`include-deleted: ${INCLUDE_DELETED} | only-id: ${ONLY_ID ?? "(all)"} | keep-going: ${KEEP_GOING}`);

  const where: Record<string, unknown> = {};
  if (!INCLUDE_DELETED) where.is_deleted = 0;
  if (ONLY_ID) where.id = ONLY_ID;

  const candidates = await prisma.articles.findMany({
    where: where as never,
    orderBy: { id: "asc" },
    select: {
      id: true,
      title: true,
      slug: true,
      status: true,
      is_deleted: true,
      user_id: true,
      user_merchant_id: true,
      publish_site_id: true,
      tracking_link: true,
      content: true,
      images: true,
      language: true,
    },
  });

  const dirty = candidates.filter((a) => isDirty(a.content) || ONLY_ID !== null);
  log(`扫描 ${candidates.length} 篇，命中污染/指定 ${dirty.length} 篇`);

  if (dirty.length === 0) {
    ok("无需处理，退出");
    return;
  }

  log("待处理清单：");
  for (const a of dirty) {
    log(
      `  #${a.id} status=${a.status} is_deleted=${a.is_deleted} site=${a.publish_site_id ?? "-"} slug=${a.slug} title="${(a.title || "").slice(0, 60)}"`,
    );
  }

  if (IS_DRY_RUN) {
    ok("DRY-RUN 结束，未改动任何数据");
    return;
  }

  let okCount = 0;
  let failCount = 0;

  for (let i = 0; i < dirty.length; i++) {
    const a = dirty[i];
    const tag = `[${i + 1}/${dirty.length}] #${a.id}`;
    log(`${tag} ▶ 开始处理 "${(a.title || "").slice(0, 60)}"`);

    try {
      if (!a.user_merchant_id) throw new Error("缺少 user_merchant_id");
      const merchant = await prisma.user_merchants.findFirst({
        where: { id: a.user_merchant_id, is_deleted: 0 },
      });
      if (!merchant) throw new Error("关联商家已删除");

      const trackingLink =
        a.tracking_link ||
        merchant.campaign_link ||
        merchant.tracking_link ||
        merchant.merchant_url ||
        "";
      if (!trackingLink) throw new Error("无可用 tracking_link");

      const merchantUrl =
        merchant.merchant_url ||
        `https://${(merchant.merchant_name || "").toLowerCase().replace(/\s+/g, "")}.com`;
      const country = merchant.target_country || "US";
      const images = Array.isArray(a.images) ? (a.images as string[]) : [];

      log(`${tag}   analyze ${merchantUrl} (country=${country}) ...`);
      const analysis = await analyzeUrl(merchantUrl, country);

      const title = a.title || analysis.titles[0]?.titleEn || `${merchant.merchant_name} Review`;

      log(`${tag}   AI 生成 ...`);
      const result = await generateMerchantArticle({
        title,
        merchantName: analysis.brandName || merchant.merchant_name,
        merchantUrl,
        trackingLink,
        country,
        products: analysis.products,
        sellingPoints: analysis.sellingPoints,
        keywords: analysis.keywords,
        images,
        userId: a.user_id,
      });

      if (isDirty(result.content)) {
        throw new Error("新生成 content 仍含 reasoning 残留（修复未生效？）");
      }

      await prisma.articles.update({
        where: { id: a.id },
        data: {
          content: result.content,
          excerpt: result.excerpt,
          meta_title: result.metaTitle,
          meta_description: result.metaDescription,
          category: result.category || "general",
          updated_at: new Date(),
        },
      });
      log(`${tag}   DB content 已更新（${result.content.length} 字）`);

      if (a.status === "published" && a.publish_site_id && a.is_deleted === 0) {
        const site = await ensureVerifiedSite(a.publish_site_id);
        if (!site) {
          log(`${tag}   ⚠ publish_site ${a.publish_site_id} 未验证，跳过外站重推（DB 已更新）`);
        } else {
          log(`${tag}   重推外站 ${site.domain} ...`);
          const publishRes = await publishArticleToSite(
            {
              id: String(a.id),
              title,
              slug: a.slug || "",
              content: result.content,
              category: result.category || "General",
              images: a.images,
              trackingLink,
            },
            site,
          );
          if (!publishRes.success) {
            throw new Error(`外站重推失败：${publishRes.error || "unknown"}`);
          }
          await prisma.articles.update({
            where: { id: a.id },
            data: {
              content: publishRes.updatedContent || result.content,
              published_url: publishRes.url || undefined,
            },
          });
          ok(`${tag}   外站重推 OK: ${publishRes.url || site.domain}`);
        }
      } else if (a.is_deleted === 1) {
        // 07 Q2：已作废篇处理完后恢复 is_deleted=0 + status=preview，等用户从前端决定是否重发
        await prisma.articles.update({
          where: { id: a.id },
          data: { is_deleted: 0, status: "preview", updated_at: new Date() },
        });
        ok(`${tag}   已恢复 is_deleted=0, status=preview（不触发外站发布，等前端手动）`);
      } else {
        log(`${tag}   status=${a.status}，不触发外站发布`);
      }

      okCount++;
      ok(`${tag} 完成`);
    } catch (e) {
      failCount++;
      fail(`${tag} 失败: ${e instanceof Error ? e.message : String(e)}`);
      if (!KEEP_GOING) {
        fail(`未加 --keep-going，立即终止（已成功 ${okCount} / 失败 ${failCount} / 剩余 ${dirty.length - i - 1}）`);
        process.exit(1);
      }
    }

    if (i < dirty.length - 1) {
      log(`   sleep ${SLEEP_BETWEEN_MS}ms ...`);
      await sleep(SLEEP_BETWEEN_MS);
    }
  }

  log(`=== 汇总: 成功 ${okCount} / 失败 ${failCount} / 共 ${dirty.length} ===`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    fail(`致命错误: ${e instanceof Error ? e.stack : e}`);
    await prisma.$disconnect();
    process.exit(1);
  });
