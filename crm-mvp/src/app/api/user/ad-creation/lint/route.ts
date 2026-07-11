import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

/**
 * POST /api/user/ad-creation/lint — D-161 员工编辑即时合规快检
 *
 * 与提交阶段 H4 final gate 完全同源（同 checkAdCompliance / 同 complianceMeta 上下文），
 * 前端在员工手动编辑标题/描述失焦后调用，命中 critical 即时标黄提示
 * 「此写法提交时会被自动重写」，把 H4 大返工提前消化到编辑期。
 *
 * 纯正则扫描（无 AI 调用），毫秒级返回。
 *
 * Body:
 *   campaign_id  - 广告系列 ID（必填，用于加载商家/合规上下文）
 *   headlines    - string[]（选填）
 *   descriptions - string[]（选填）
 *   callouts     - string[]（选填）
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  let body: {
    campaign_id?: string;
    headlines?: string[];
    descriptions?: string[];
    callouts?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return apiError("请求体解析失败", 400);
  }
  if (!body.campaign_id) return apiError("缺少 campaign_id");

  // 保持索引与前端输入框对齐：非字符串置空（checkAdCompliance 会跳过空串），不能 filter 移位
  const toAligned = (arr: unknown): string[] =>
    Array.isArray(arr) ? arr.map((s) => (typeof s === "string" ? s : "")) : [];
  const headlines = toAligned(body.headlines);
  const descriptions = toAligned(body.descriptions);
  const callouts = toAligned(body.callouts);
  if (headlines.length + descriptions.length + callouts.length === 0) {
    return apiSuccess({ violations: [], criticalCount: 0 });
  }

  const campaign = await prisma.campaigns.findFirst({
    where: { id: BigInt(body.campaign_id), user_id: BigInt(user.userId), is_deleted: 0 },
    select: { id: true, user_merchant_id: true },
  });
  if (!campaign) return apiError("广告系列不存在", 404);

  const merchant = await prisma.user_merchants.findFirst({
    where: { id: campaign.user_merchant_id, is_deleted: 0 },
    select: { merchant_name: true },
  });
  const adGroup = await prisma.ad_groups.findFirst({
    where: { campaign_id: campaign.id, is_deleted: 0 },
    select: { id: true },
  });
  const adCreative = adGroup
    ? await prisma.ad_creatives.findFirst({
      where: { ad_group_id: adGroup.id, is_deleted: 0 },
      select: { crawl_cache: true, final_url: true },
    })
    : null;

  // 合规上下文与提交 H4 同源：优先生成阶段落库的 complianceMeta，无 meta 时现场推导
  const { checkAdCompliance } = await import("@/lib/ad-compliance-checker");
  const { detectIndustryProfile, INDUSTRY_PROFILES } = await import("@/lib/industry-profile");
  const { extractBrandRoot } = await import("@/lib/country-url-resolver");

  let cacheObj: { pageText?: string; complianceMeta?: { allowBrand?: boolean; industryId?: string | null; merchantNameUsed?: string } } | null = null;
  try {
    if (adCreative?.crawl_cache) {
      cacheObj = typeof adCreative.crawl_cache === "string"
        ? JSON.parse(adCreative.crawl_cache)
        : (adCreative.crawl_cache as any);
    }
  } catch {}
  const meta = cacheObj?.complianceMeta;
  const merchantName = meta?.merchantNameUsed || extractBrandRoot(merchant?.merchant_name || "");
  const industryProfile = meta?.industryId
    ? (INDUSTRY_PROFILES.find((p) => p.id === meta.industryId) ?? null)
    : detectIndustryProfile({
      merchantName,
      category: null,
      pageText: (cacheObj?.pageText || "").slice(0, 2000),
    });

  // 品牌自有站推定：meta.allowBrand 是生成时的快照（AI 画像默认 unauthorized 常误判为 false），
  // 品牌词=落地域名且无商标类拒登记录时按 true 处理，存量草稿立即摆脱 trademark_leak 误报
  let allowBrand = meta?.allowBrand === true;
  if (!allowBrand) {
    const { shouldAllowBrandByOwnDomain } = await import("@/lib/intellicenter/ad-creation/policy-preflight");
    allowBrand = await shouldAllowBrandByOwnDomain(
      campaign.user_merchant_id,
      merchantName,
      adCreative?.final_url || "",
    );
  }

  const result = checkAdCompliance(headlines, descriptions, {
    merchantName,
    industryProfile,
    allowBrand,
  }, callouts);

  return apiSuccess({
    criticalCount: result.criticalCount,
    minorCount: result.minorCount,
    violations: result.violations.map((v) => ({
      field: v.field,
      index: v.index,
      rule: v.rule,
      severity: v.severity,
      matchedTerm: v.matchedTerm ?? null,
    })),
  });
}
