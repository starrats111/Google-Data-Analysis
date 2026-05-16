/**
 * D-008 F-1：GET /api/user/atc/regions
 *
 * 返回 ATC 区域 / 国家清单（按优先级排序），供前端 3 个入口异步加载：
 *   - /user/intelligence 顶部 region 下拉
 *   - /user/merchants 「查竞争度」Popover region 下拉
 *   - /user/advertisers 今日广告 Tab 顶部 region 筛选
 *
 * 单一信源：lib/atc-regions.ts；扩展新国家只改一处，前端自动同步。
 *
 * 响应：
 *   {
 *     code: 0,
 *     data: {
 *       regions: [
 *         { value: "US", label: "🇺🇸 美国 (US)", zhName: "美国", flag: "🇺🇸" },
 *         ...
 *       ]
 *     }
 *   }
 */

import { NextRequest } from "next/server";
import { withUser } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/constants";
import { getDisplayRegions } from "@/lib/atc-regions";

export const GET = withUser(async (_req: NextRequest) => {
  return apiSuccess({ regions: getDisplayRegions() });
});
