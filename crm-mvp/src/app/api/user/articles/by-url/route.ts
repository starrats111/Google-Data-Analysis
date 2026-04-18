import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

// C-020 R1.1：按 URL 创建商家（见设计方案 §20.5.3 / §20.5.7）
// 步骤：
//   1. 规范化 URL，提取 domain
//   2. step 2：本用户 source=url_direct 同 URL → 复用
//   3. step 3：本用户任何 source 同 domain → 复用（不改 status/source）
//   4. step 4：campaigns JOIN user_merchants(source=platform) 是否历史有 → offline，否则 url_only
//   5. step 5：新建 user_merchants（source=url_direct, status=claimed, claimed_at=now）

const TRACKING_PARAMS = new Set<string>([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "gclid", "fbclid", "msclkid", "dclid", "gbraid", "wbraid",
  "mc_cid", "mc_eid", "yclid", "_kx",
]);

function normalizeUrl(raw: string): { normalized: string; hostname: string } | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // 剔除 tracking 参数
    const keys = Array.from(u.searchParams.keys());
    for (const k of keys) {
      if (TRACKING_PARAMS.has(k.toLowerCase())) u.searchParams.delete(k);
    }
    u.hash = "";
    const hostname = u.hostname.replace(/^www\./i, "").toLowerCase();
    return { normalized: u.toString(), hostname };
  } catch {
    return null;
  }
}

export const POST = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return apiError("请求体必须为 JSON");

  const merchantUrlRaw = String(body.merchant_url || "").trim();
  const platformConnectionIdRaw = String(body.platform_connection_id || "").trim();
  const country = String(body.country || "").trim().toUpperCase();
  const publishSiteIdRaw = String(body.publish_site_id || "").trim();
  const merchantIdInput = String(body.merchant_id || "").trim();
  const merchantNameInput = String(body.merchant_name || "").trim();
  const trackingLinkInput = String(body.tracking_link || "").trim();

  if (!merchantUrlRaw) return apiError("merchant_url 必填");
  if (!platformConnectionIdRaw) return apiError("platform_connection_id 必填");
  if (!country) return apiError("country 必填");
  if (!publishSiteIdRaw) return apiError("publish_site_id 必填");

  const norm = normalizeUrl(merchantUrlRaw);
  if (!norm) return apiError("merchant_url 必须是合法的 http(s):// URL");
  const { normalized, hostname } = norm;

  const platformConnId = BigInt(platformConnectionIdRaw);
  const conn = await prisma.platform_connections.findFirst({
    where: { id: platformConnId, user_id: userId, is_deleted: 0 },
  });
  if (!conn) return apiError("平台账号不存在或不属当前用户", 400);
  const platform = conn.platform;

  const publishSiteId = BigInt(publishSiteIdRaw);
  const site = await prisma.publish_sites.findFirst({
    where: { id: publishSiteId, is_deleted: 0 },
  });
  if (!site) return apiError("发布站点不存在", 400);

  // step 2：本用户 source=url_direct 同 URL/domain 复用
  const reuseUrlDirect = await prisma.user_merchants.findFirst({
    where: {
      user_id: userId,
      is_deleted: 0,
      source: "url_direct",
      OR: [
        { merchant_url: normalized },
        { merchant_url: { contains: hostname } },
      ],
    },
  });
  if (reuseUrlDirect) {
    return apiSuccess({
      user_merchant_id: String(reuseUrlDirect.id),
      reused: true,
      stage: "step2_reuse_url_direct",
      source: reuseUrlDirect.source,
      listing_status: reuseUrlDirect.listing_status,
      publish_site_id: String(publishSiteId),
      country,
    });
  }

  // step 3：本用户任何 source 同 domain 复用（不改 status/source）
  const reuseAny = await prisma.user_merchants.findFirst({
    where: {
      user_id: userId,
      is_deleted: 0,
      OR: [
        { merchant_url: { contains: hostname } },
        { merchant_name: { contains: hostname } },
      ],
    },
  });
  if (reuseAny) {
    return apiSuccess({
      user_merchant_id: String(reuseAny.id),
      reused: true,
      stage: "step3_reuse_existing",
      source: reuseAny.source,
      listing_status: reuseAny.listing_status,
      publish_site_id: String(publishSiteId),
      country,
    });
  }

  // step 4：campaigns JOIN user_merchants(source=platform) 判 offline
  const offlineRows = await prisma.$queryRaw<Array<{ hit: number }>>`
    SELECT 1 AS hit
    FROM campaigns c
    JOIN user_merchants um ON c.user_merchant_id = um.id
    WHERE c.user_id = ${userId}
      AND c.is_deleted = 0
      AND um.is_deleted = 0
      AND um.source = 'platform'
      AND (um.merchant_url LIKE ${"%" + hostname + "%"}
           OR um.merchant_name LIKE ${"%" + hostname + "%"})
    LIMIT 1
  `;
  const listingStatus = offlineRows.length > 0 ? "offline" : "url_only";

  const finalMerchantName = merchantNameInput || hostname;

  // step 5：新建 user_merchants
  const connectionLinks: Record<string, string> = {};
  if (trackingLinkInput) {
    connectionLinks[String(platformConnId)] = trackingLinkInput;
  }

  const created = await prisma.user_merchants.create({
    data: {
      user_id: userId,
      platform,
      merchant_id: merchantIdInput,
      merchant_name: finalMerchantName,
      merchant_url: normalized,
      target_country: country,
      platform_connection_id: platformConnId,
      status: "claimed",
      claimed_at: new Date(),
      source: "url_direct",
      listing_status: listingStatus,
      tracking_link: trackingLinkInput || null,
      campaign_link: trackingLinkInput || null,
      connection_campaign_links: trackingLinkInput
        ? connectionLinks as unknown as object
        : undefined,
    },
  });

  return apiSuccess({
    user_merchant_id: String(created.id),
    reused: false,
    stage: "step5_create",
    source: created.source,
    listing_status: created.listing_status,
    publish_site_id: String(publishSiteId),
    country,
  });
});
