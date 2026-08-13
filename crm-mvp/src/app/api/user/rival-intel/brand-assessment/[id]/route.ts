/**
 * 单次品牌评估任务的详情：任务状态 + 各国结果。
 * 前端在「广告情报 → 品牌评估」里轮询这个接口看进度和结果。
 */
import { NextRequest } from "next/server";
import { apiError, apiSuccess } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import { serializeData } from "@/lib/auth";
import * as repo from "@/lib/rival-intel/brand-assessment/repository";

export const GET = withUser(async (_req: NextRequest, { params }) => {
  const id = params?.id;
  if (!id) return apiError("缺少任务 ID");

  const job = await repo.getJobById(BigInt(id));
  if (!job) return apiError("评估任务不存在", 404);

  // 结果全公司共享，不做 user_id 校验（同 listRecentJobs 的口径）
  const results = await repo.listResultsByJob(job.id);

  return apiSuccess(
    serializeData({
      job: {
        id: job.id.toString(),
        domain: job.domain,
        countries: job.countries,
        status: job.status,
        force_refresh: job.force_refresh === 1,
        estimated_cost_usd: job.estimated_cost_usd,
        actual_cost_usd: job.actual_cost_usd,
        error_message: job.error_message,
        started_at: job.started_at,
        finished_at: job.finished_at,
        created_at: job.created_at,
      },
      results: results.map((r) => ({
        id: r.id.toString(),
        country: r.country,
        brand_token: r.brand_token,
        brand_level: r.brand_level,
        country_snapshot: r.country_snapshot,
        brand_own_ads: r.brand_own_ads,
        non_brand_ads: r.non_brand_ads,
        source: r.source,
        ttl_expires_at: r.ttl_expires_at,
        updated_at: r.updated_at,
      })),
    }),
  );
});
