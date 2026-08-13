/**
 * 按投放国家验证落地页可达性（竞品情报向导的「验证链接」）。
 *
 * D-233：这条是 kyads 移植过来的能力，CRM 原有的 `checkReachability` 是从服务器直连探测。
 * 联盟落地页常做地域门禁——服务器在腾讯云新加坡，直连 US 的 offer 页经常吃 403 或被跳到
 * 别的国家站，探测结果没有参考价值。kyads 的做法是先经目标国代理确认出口 IP 落在该国，
 * 再 HEAD + GET 探测，出口国不对就明确告知「代理不可信」而不是给个假的可达结论。
 *
 * 代理走 CRM 的 AI 爬取出口（见 rival-intel/deps/proxy.ts），不占换链接的 kookeey 名额。
 */
import { NextRequest } from "next/server";
import { apiError, apiSuccess } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import {
  createCountryAwareProbeContext,
  probeUrlForGoogleAds,
} from "@/lib/rival-intel/ad-create/country-aware-url-probe";
import { deriveRootDomainFromFinalUrl } from "@/lib/rival-intel/ad-create/final-url";

export const POST = withUser(async (req: NextRequest) => {
  const body = await req.json().catch(() => ({}));
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  const countryCode = typeof body?.country_code === "string" ? body.country_code.trim() : "";

  if (!url || !/^https?:\/\//i.test(url)) return apiError("请提供合法的 http(s) 链接");
  if (!countryCode) return apiError("缺少投放国家");

  const context = await createCountryAwareProbeContext(countryCode);
  const result = await probeUrlForGoogleAds(url, context);

  return apiSuccess({
    url: result.url,
    final_url: result.finalUrl,
    // 反推的根域名给前端回填「目标域名」，员工不用自己看着链接抄
    domain: deriveRootDomainFromFinalUrl(result.finalUrl) ?? null,
    publishable: result.publishable,
    head_status: result.headStatus,
    get_status: result.getStatus,
    reason: result.reason,
    proxy_ip: result.proxyIp ?? null,
    proxy_country_code: result.proxyCountryCode ?? null,
    proxy_warning: result.proxyWarning ?? null,
  });
});
