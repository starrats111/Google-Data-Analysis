import { NextRequest } from "next/server";
import { getAdminFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { extractSheetId, fetchViolations, fetchRecommendations } from "@/lib/merchant-sheet-sync";

// ── GET: 获取配置 + 违规/推荐列表 ──
export async function GET(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") || "config"; // config / violations / recommendations

  if (action === "config") {
    const cfg = await prisma.sheet_configs.findFirst({
      where: { config_type: "merchant_sheet", is_deleted: 0 },
    });
    return apiSuccess({
      sheet_url: cfg?.sheet_url || "",
      last_synced_at: cfg?.last_synced_at?.toISOString() || null,
    });
  }

  // 查询违规/推荐列表
  const search = searchParams.get("search") || "";
  const page = parseInt(searchParams.get("page") || "1");
  const pageSize = parseInt(searchParams.get("pageSize") || "50");

  if (action === "violations") {
    const where: Record<string, unknown> = { is_deleted: 0 };
    if (search) where.merchant_name = { contains: search };
    const [total, items] = await Promise.all([
      prisma.merchant_violations.count({ where: where as never }),
      prisma.merchant_violations.findMany({
        where: where as never, orderBy: { created_at: "desc" },
        skip: (page - 1) * pageSize, take: pageSize,
      }),
    ]);
    return apiSuccess(serializeData({ total, items, page, pageSize }));
  }

  if (action === "recommendations") {
    const where: Record<string, unknown> = { is_deleted: 0 };
    if (search) where.merchant_name = { contains: search };
    const [total, items] = await Promise.all([
      prisma.merchant_recommendations.count({ where: where as never }),
      prisma.merchant_recommendations.findMany({
        where: where as never, orderBy: { created_at: "desc" },
        skip: (page - 1) * pageSize, take: pageSize,
      }),
    ]);
    return apiSuccess(serializeData({ total, items, page, pageSize }));
  }

  return apiError("未知 action");
}

// ── POST: 保存链接 / 同步 / 删除记录 ──
export async function POST(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const body = await req.json();
  const action = body.action; // save_url / sync / delete_violation / delete_recommendation

  // 保存共享表格链接
  if (action === "save_url") {
    const { sheet_url } = body;
    if (!sheet_url || !extractSheetId(sheet_url)) return apiError("无效的 Google Sheets 链接");

    const existing = await prisma.sheet_configs.findFirst({
      where: { config_type: "merchant_sheet", is_deleted: 0 },
    });
    if (existing) {
      await prisma.sheet_configs.update({
        where: { id: existing.id },
        data: { sheet_url, updated_by: BigInt(admin.userId) },
      });
    } else {
      await prisma.sheet_configs.create({
        data: { config_type: "merchant_sheet", sheet_url, updated_by: BigInt(admin.userId) },
      });
    }
    return apiSuccess(null, "共享表格链接已保存");
  }

  // 统一同步
  if (action === "sync") {
    const cfg = await prisma.sheet_configs.findFirst({
      where: { config_type: "merchant_sheet", is_deleted: 0 },
    });
    if (!cfg?.sheet_url) return apiError("未配置共享表格链接");

    const sheetUrl = cfg.sheet_url;
    const batchTs = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

    // 同步违规商家
    let vioTotal = 0, vioNew = 0, vioSkipped = 0, vioMarked = 0;
    try {
      const violations = await fetchViolations(sheetUrl);
      vioTotal = violations.length;
      const vioBatch = `SHEET-VIO-${batchTs}`;

      // 收集违规商家名（精确 + 基础名）用于重置判断
      const { stripCountrySuffix } = await import("@/lib/merchant-sheet-sync");
      const violationNames = new Set(violations.map((v) => v.name.toLowerCase()));
      const violationBaseNames = new Set(violations.map((v) => stripCountrySuffix(v.name).toLowerCase()));

      // 重置不在本次黑名单中的商家
      const previouslyViolated = await prisma.user_merchants.findMany({
        where: { is_deleted: 0, violation_status: "violated" },
        select: { id: true, merchant_name: true },
      });
      for (const m of previouslyViolated) {
        const mName = (m.merchant_name || "").toLowerCase();
        const mBase = stripCountrySuffix(m.merchant_name || "").toLowerCase();
        if (!violationNames.has(mName) && !violationBaseNames.has(mBase)) {
          await prisma.user_merchants.update({
            where: { id: m.id },
            data: { violation_status: "normal", violation_time: null },
          });
        }
      }

      for (const v of violations) {
        let vtime: Date | null = null;
        if (v.time) {
          const raw = v.time.trim();
          if (/^\d{8}$/.test(raw)) vtime = new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`);
          else { const d = new Date(raw); if (!isNaN(d.getTime())) vtime = d; }
        }

        const exists = await prisma.merchant_violations.findFirst({
          where: { merchant_name: v.name, is_deleted: 0 },
        });
        if (exists) {
          // 更新已有记录（修正原因、时间等字段）
          await prisma.merchant_violations.update({
            where: { id: exists.id },
            data: {
              platform: v.platform || exists.platform,
              merchant_domain: v.domain || exists.merchant_domain,
              violation_reason: v.reason,
              violation_time: vtime || exists.violation_time,
              source: v.source || exists.source,
              upload_batch: vioBatch,
            },
          });
          vioSkipped++;
          // 继续处理跨平台匹配（不 skip）
        } else {
          await prisma.merchant_violations.create({
            data: {
              merchant_name: v.name, platform: v.platform, merchant_domain: v.domain || null,
              violation_reason: v.reason, violation_time: vtime, source: v.source || null, upload_batch: vioBatch,
            },
          });
          vioNew++;
        }

        // 跨平台匹配 user_merchants（商家名精确匹配 + 去掉国家代码后匹配 + 域名匹配）
        const { stripCountrySuffix } = await import("@/lib/merchant-sheet-sync");
        const baseName = stripCountrySuffix(v.name);
        const nameConditions: any[] = [{ merchant_name: { equals: v.name } }];
        if (baseName !== v.name) {
          // 违规表中 "bofrost DE" → 也匹配 user_merchants 中的 "bofrost"
          nameConditions.push({ merchant_name: { equals: baseName } });
        }
        // 反向：user_merchants 中 "bofrost DE" 应匹配违规表中 "bofrost"
        nameConditions.push({ merchant_name: { startsWith: baseName + " " } });
        if (v.domain) {
          nameConditions.push({ merchant_url: { contains: v.domain } });
        }
        const matched = await prisma.user_merchants.findMany({
          where: { is_deleted: 0, OR: nameConditions },
        });
        for (const m of matched) {
          if (m.violation_status !== "violated") {
            await prisma.user_merchants.update({
              where: { id: m.id },
              data: { violation_status: "violated", violation_time: vtime || new Date() },
            });
            vioMarked++;
          }
        }
      }
    } catch (e) { console.error("[AdminSheetSync] 违规同步失败:", e); }

    // 同步推荐商家
    let recTotal = 0, recNew = 0, recSkipped = 0, recMarked = 0;
    try {
      const recs = await fetchRecommendations(sheetUrl);
      recTotal = recs.length;
      const recBatch = `SHEET-REC-${batchTs}`;
      for (const r of recs) {
        const exists = await prisma.merchant_recommendations.findFirst({
          where: { merchant_name: r.name, is_deleted: 0 },
        });
        if (exists) { recSkipped++; continue; }

        await prisma.merchant_recommendations.create({
          data: {
            merchant_name: r.name, roi_reference: r.roi || null, commission_info: r.commission || null,
            settlement_info: r.settlement || null, remark: r.remark || null, share_time: r.time || null, upload_batch: recBatch,
          },
        });
        recNew++;

        const matched = await prisma.user_merchants.findMany({
          where: { is_deleted: 0, merchant_name: { equals: r.name } },
        });
        for (const m of matched) {
          if (m.recommendation_status !== "recommended") {
            await prisma.user_merchants.update({
              where: { id: m.id },
              data: {
                recommendation_status: "recommended",
                recommendation_time: new Date(),
                // 推荐商家不应该同时是违规商家，清除违规标记
                violation_status: "normal",
                violation_time: null,
              },
            });
            recMarked++;
          }
        }
      }
    } catch (e) { console.error("[AdminSheetSync] 推荐同步失败:", e); }

    await prisma.sheet_configs.update({ where: { id: cfg.id }, data: { last_synced_at: new Date() } });

    return apiSuccess(serializeData({
      violation: { total: vioTotal, new: vioNew, skipped: vioSkipped, marked: vioMarked },
      recommendation: { total: recTotal, new: recNew, skipped: recSkipped, marked: recMarked },
    }), "统一同步完成");
  }

  // 删除违规记录
  if (action === "delete_violation") {
    const { id } = body;
    if (!id) return apiError("缺少 ID");
    await prisma.merchant_violations.update({ where: { id: BigInt(id) }, data: { is_deleted: 1 } });
    return apiSuccess(null, "已删除");
  }

  // 删除推荐记录
  if (action === "delete_recommendation") {
    const { id } = body;
    if (!id) return apiError("缺少 ID");
    await prisma.merchant_recommendations.update({ where: { id: BigInt(id) }, data: { is_deleted: 1 } });
    return apiSuccess(null, "已删除");
  }

  return apiError("未知操作");
}
