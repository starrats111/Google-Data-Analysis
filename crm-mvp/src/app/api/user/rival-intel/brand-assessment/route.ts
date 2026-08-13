/**
 * 品牌评估：发起任务 + 读历史。
 *
 * D-233：评估结果按 (域名, 国家) 全公司共享（07 立项时定的：付费数据不重复买），
 * 所以历史列表不按 user_id 过滤，谁发起的记在 user_id 上只作审计。
 *
 * 任务不在请求里跑：SerpApi 四个接口 + LLM 评估单国家要几十秒，多国家必然打爆
 * 请求超时。落一行 pending，由 cron 的 runCronTick 抢锁执行（与 CRM 其它 runner 同构）。
 */
import { NextRequest } from "next/server";
import { apiError, apiSuccess } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import { serializeData } from "@/lib/auth";
import * as repo from "@/lib/rival-intel/brand-assessment/repository";
import { deriveRootDomainFromFinalUrl } from "@/lib/rival-intel/ad-create/final-url";

/** SerpApi 四接口 + 一次 LLM 的按次成本，用于给员工一个下单前的预估 */
const ESTIMATED_COST_PER_COUNTRY_USD = 0.07;
const MAX_COUNTRIES = 10;

export const GET = withUser(async (req: NextRequest) => {
  const limit = Number(req.nextUrl.searchParams.get("limit") || 20);
  const jobs = await repo.listRecentJobs(Number.isFinite(limit) ? limit : 20);
  return apiSuccess(serializeData({ items: jobs }));
});

export const POST = withUser(async (req: NextRequest, { user }) => {
  const body = await req.json().catch(() => ({}));
  const rawDomain = typeof body?.domain === "string" ? body.domain.trim() : "";
  const countriesRaw = Array.isArray(body?.countries) ? body.countries : [];
  const forceRefresh = body?.force_refresh === true;

  // 员工经常直接粘整条落地页 URL，这里统一归一成根域名，避免同一站点被存成两条
  const domain = rawDomain.includes("/") || rawDomain.includes(":")
    ? deriveRootDomainFromFinalUrl(rawDomain)
    : rawDomain.replace(/^www\./i, "").toLowerCase();
  if (!domain) return apiError("请填写有效的域名");

  const countries: string[] = Array.from(
    new Set(
      (countriesRaw as unknown[])
        .filter((c): c is string => typeof c === "string")
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean),
    ),
  );
  if (countries.length === 0) return apiError("请至少选择一个国家");
  if (countries.length > MAX_COUNTRIES) return apiError(`单次最多 ${MAX_COUNTRIES} 个国家`);

  const job = await repo.createJob({
    userId: BigInt(user.userId),
    domain,
    countries,
    forceRefresh,
    estimatedCostUsd: Number((countries.length * ESTIMATED_COST_PER_COUNTRY_USD).toFixed(4)),
  });

  return apiSuccess(
    serializeData({ id: job.id.toString(), domain, countries, status: job.status }),
    "已提交评估任务，后台执行中",
  );
});
