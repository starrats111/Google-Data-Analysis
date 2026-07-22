import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { serializeData } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { verifyHermesToken } from "@/lib/hermes-auth";

// HM-D23：Hermes 委托发文 —— 列出可用发布站点（Bearer HERMES_API_TOKEN）
export async function GET(req: NextRequest) {
  const authErr = verifyHermesToken(req);
  if (authErr) return authErr;

  try {
    const sites = await prisma.publish_sites.findMany({
      where: { is_deleted: 0, status: "active" },
      select: {
        id: true,
        site_name: true,
        domain: true,
        site_type: true,
        article_html_pattern: true,
        verified: true,
      },
      orderBy: { id: "asc" },
    });

    // 每个站点补充最近一次发布时间 + 各商家最近发布日（Hermes 端做「同品牌同站 ≥7 天」节奏校验）
    const recent = await prisma.articles.groupBy({
      by: ["publish_site_id", "merchant_name"],
      where: { is_deleted: 0, status: "published", publish_site_id: { not: null } },
      _max: { published_at: true },
    });
    const recentMap = new Map<string, { merchant_name: string | null; last_published_at: Date | null }[]>();
    for (const r of recent) {
      const key = String(r.publish_site_id);
      if (!recentMap.has(key)) recentMap.set(key, []);
      recentMap.get(key)!.push({ merchant_name: r.merchant_name, last_published_at: r._max.published_at });
    }

    // HM-D24：各联盟连接绑定的站点（Hermes 正常发文走绑定站；违规链接绝不发绑定站）
    const ownerUsername = process.env.HERMES_ARTICLE_USERNAME || "wj07";
    const owner = await prisma.users.findFirst({
      where: { username: ownerUsername, is_deleted: 0 },
      select: { id: true },
    });
    const bindings = owner
      ? (await prisma.platform_connections.findMany({
          where: { user_id: owner.id, is_deleted: 0, publish_site_id: { not: null } },
          select: { platform: true, account_name: true, publish_site_id: true },
        })).map((b) => ({
          platform: b.platform,
          account_name: b.account_name.trim(),
          site_id: String(b.publish_site_id),
        }))
      : [];

    return apiSuccess(serializeData({
      sites: sites.map((s) => ({
        ...s,
        recent_merchants: recentMap.get(String(s.id)) || [],
      })),
      bindings,
    }));
  } catch (err) {
    console.error("[HermesSites] GET 异常:", err);
    return apiError("获取站点列表失败", 500);
  }
}
