import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { tryValidateUrl, isJsRedirectUrl } from "@/lib/url-validator";
import { judgeSitelinkDomain, sitelinkDomainAllowed } from "@/lib/sitelink-domain-verdict";

/**
 * GET /api/user/ad-creation/check-url?url=xxx
 * 验证站内链接是否真实有效（含软 404 检测）
 *
 * D-350：可选传 `campaign_id`，附带做一次域名归属判定（final_url 优先、merchant_url 兜底，
 * 判据 D-316/D-318 字面 + D-328 页面自证）。放在服务端是因为自证要抓页面，前端做不了；
 * 不传 campaign_id 时行为与此前完全一致，只查可达性。
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const url = searchParams.get("url");
  if (!url) return apiError("缺少 url 参数");
  const campaignId = searchParams.get("campaign_id");

  try {
    new URL(url);
  } catch {
    return apiSuccess({ ok: false, reason: "URL 格式无效" });
  }

  if (isJsRedirectUrl(url)) {
    try {
      const baseUrl = new URL(url).origin;
      const baseResult = await tryValidateUrl(baseUrl);
      if (baseResult.ok) {
        return apiSuccess({
          ok: true, status: 200, finalUrl: url,
          note: "JS 重定向 URL（基础域名有效）",
          warning: "此链接包含 JS 重定向，建议使用直接页面链接",
        });
      }
    } catch {}
  }

  const result = await tryValidateUrl(url);

  // ── D-350：域名归属判定（只在传了 campaign_id 时做） ──
  // 基准取 final_url 优先、merchant_url 兜底：Google Ads 要求 sitelink 与落地页同域，
  // 而 merchant_url 是联盟后台登记的那个（Veracity 案：登记 veracityselfcare.com，
  // 落地页与全部站内链接都在 veracityhealth.co/.com 上）。
  let domain: Awaited<ReturnType<typeof judgeSitelinkDomain>> | null = null;
  if (campaignId) {
    try {
      const baselines = await loadDomainBaselines(campaignId, user.userId);
      if (baselines) domain = await judgeSitelinkDomain(url, baselines);
    } catch (e) {
      // 判不出来不改变可达性结论——宁可漏判，不可错杀（D-316 一贯取向）
      console.warn("[check-url] D-350 域名归属判定异常（按放行处理）:", e instanceof Error ? e.message : e);
    }
  }

  return apiSuccess({
    ok: result.ok,
    status: result.status,
    finalUrl: result.finalUrl,
    reason: result.ok ? undefined : result.reason,
    note: result.ok ? result.reason : undefined,
    domainVerdict: domain?.verdict,
    domainAllowed: domain ? sitelinkDomainAllowed(domain.verdict) : undefined,
    domainBaseline: domain?.matchedBaseline,
    domainVia: domain?.via,
  });
}

/**
 * D-350：取该 campaign 的两个域名基准。campaign 必须属于当前用户，否则返回 null（不泄露他人数据）。
 */
async function loadDomainBaselines(
  campaignId: string,
  userId: string | number,
): Promise<{ finalUrl: string | null; merchantUrl: string | null } | null> {
  const { default: prisma } = await import("@/lib/prisma");
  const campaign = await prisma.campaigns.findFirst({
    where: { id: BigInt(campaignId), user_id: BigInt(userId), is_deleted: 0 },
    select: { id: true, user_merchant_id: true },
  });
  if (!campaign) return null;

  const adGroup = await prisma.ad_groups.findFirst({
    where: { campaign_id: campaign.id, is_deleted: 0 },
    select: { id: true },
  });
  const adCreative = adGroup
    ? await prisma.ad_creatives.findFirst({
        where: { ad_group_id: adGroup.id, is_deleted: 0 },
        select: { final_url: true },
      })
    : null;
  const merchant = campaign.user_merchant_id
    ? await prisma.user_merchants.findFirst({
        where: { id: campaign.user_merchant_id },
        select: { merchant_url: true },
      })
    : null;

  return { finalUrl: adCreative?.final_url ?? null, merchantUrl: merchant?.merchant_url ?? null };
}
