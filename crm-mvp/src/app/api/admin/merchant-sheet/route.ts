import { NextRequest } from "next/server";
import { getAdminFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import {
  extractSheetId, fetchViolations, fetchRecommendations,
  parseCsv, parseViolationRows, parseRecommendationRows,
  stripCountrySuffix,
  type ViolationRecord, type RecommendationRecord,
} from "@/lib/merchant-sheet-sync";

// 同步状态跟踪（进程级别）
let syncState: {
  running: boolean;
  startedAt: string | null;
  progress: string;
  result: Record<string, unknown> | null;
  error: string | null;
} = { running: false, startedAt: null, progress: "", result: null, error: null };

// 保持对后台 sync Promise 的引用，防止被 GC
let activeSyncPromise: Promise<void> | null = null;

function log(msg: string) {
  console.error(`[AdminSheetSync ${new Date().toISOString()}] ${msg}`);
}

// ── GET: 获取配置 + 违规/推荐列表 ──
export async function GET(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") || "config";

  if (action === "config") {
    const cfg = await prisma.sheet_configs.findFirst({
      where: { config_type: "merchant_sheet", is_deleted: 0 },
    });
    let sa_email: string | null = null;
    try {
      const { getServiceAccountEmail } = await import("@/lib/google-sheets-auth");
      sa_email = await getServiceAccountEmail();
    } catch { /* ignore */ }
    return apiSuccess({
      sheet_url: cfg?.sheet_url || "",
      last_synced_at: cfg?.last_synced_at?.toISOString() || null,
      sa_email,
    });
  }

  if (action === "sync_status") {
    // 触摸 activeSyncPromise 让 Node.js 保持引用
    if (activeSyncPromise && syncState.running) {
      void activeSyncPromise;
    }
    return apiSuccess({
      running: syncState.running,
      startedAt: syncState.startedAt,
      progress: syncState.progress,
      result: syncState.result ? serializeData(syncState.result) : null,
      error: syncState.error,
    });
  }

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
  const action = body.action;

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

  if (action === "sync") {
    if (syncState.running) {
      return apiSuccess({ async: true, progress: syncState.progress }, "同步正在进行中，请稍候…");
    }

    const cfg = await prisma.sheet_configs.findFirst({
      where: { config_type: "merchant_sheet", is_deleted: 0 },
    });
    if (!cfg?.sheet_url) return apiError("未配置共享表格链接");

    const csvData = body.csv_data as string | undefined;

    syncState = { running: true, startedAt: new Date().toISOString(), progress: "正在获取数据…", result: null, error: null };

    activeSyncPromise = doSyncInBackground(cfg.id, cfg.sheet_url, csvData).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      log(`FATAL: ${msg}`);
      syncState.running = false;
      syncState.error = msg;
      syncState.progress = "同步失败";
    }).finally(() => { activeSyncPromise = null; });

    return apiSuccess({ async: true }, "同步已启动，正在后台执行…");
  }

  if (action === "delete_violation") {
    const { id } = body;
    if (!id) return apiError("缺少 ID");
    await prisma.merchant_violations.update({ where: { id: BigInt(id) }, data: { is_deleted: 1 } });
    return apiSuccess(null, "已删除");
  }

  if (action === "delete_recommendation") {
    const { id } = body;
    if (!id) return apiError("缺少 ID");
    await prisma.merchant_recommendations.update({ where: { id: BigInt(id) }, data: { is_deleted: 1 } });
    return apiSuccess(null, "已删除");
  }

  return apiError("未知操作");
}

// ── 后台异步同步 ──

async function doSyncInBackground(cfgId: bigint, sheetUrl: string, csvData?: string) {
  const t0 = Date.now();
  const batchTs = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

  let violations: ViolationRecord[] = [];
  let recommendations: RecommendationRecord[] = [];

  try {
    syncState.progress = "正在从 Google Sheets 获取数据…";
    log("Fetching data from Google Sheets...");
    if (csvData) {
      const rows = parseCsv(csvData);
      violations = parseViolationRows(rows);
      recommendations = parseRecommendationRows(rows);
    } else {
      violations = await fetchViolations(sheetUrl);
      recommendations = await fetchRecommendations(sheetUrl);
    }
    log(`Parsed: ${violations.length} violations, ${recommendations.length} recommendations`);
  } catch (e: any) {
    syncState.running = false;
    syncState.error = `数据获取/解析失败: ${e?.message || e}`;
    syncState.progress = "数据获取失败";
    log(`Data fetch failed: ${e?.message || e}`);
    return;
  }

  // ── 同步违规商家（批量优化） ──
  let vioTotal = violations.length, vioNew = 0, vioUpdated = 0, vioMarked = 0;
  let vioError: string | null = null;
  try {
    syncState.progress = `正在同步 ${vioTotal} 条违规商家…`;
    log(`Syncing ${vioTotal} violations...`);
    const vioBatch = `SHEET-VIO-${batchTs}`;

    const violationNames = new Set(violations.map((v) => v.name.toLowerCase()));
    const violationBaseNames = new Set(violations.map((v) => stripCountrySuffix(v.name).toLowerCase()));

    // 批量清除不再违规的商家
    const previouslyViolated = await prisma.user_merchants.findMany({
      where: { is_deleted: 0, violation_status: "violated" },
      select: { id: true, merchant_name: true },
    });
    const idsToUnmark = previouslyViolated
      .filter((m) => {
        const n = (m.merchant_name || "").toLowerCase();
        const b = stripCountrySuffix(m.merchant_name || "").toLowerCase();
        return !violationNames.has(n) && !violationBaseNames.has(b);
      })
      .map((m) => m.id);
    if (idsToUnmark.length > 0) {
      await prisma.user_merchants.updateMany({
        where: { id: { in: idsToUnmark } },
        data: { violation_status: "normal", violation_time: null },
      });
      log(`Unmarked ${idsToUnmark.length} merchants no longer violated`);
    }

    // 预加载现有违规记录到内存中，避免 N+1 查询
    const existingViolations = await prisma.merchant_violations.findMany({
      where: { is_deleted: 0 },
      select: { id: true, merchant_name: true, platform: true, merchant_domain: true, violation_time: true, source: true },
    });
    const existingMap = new Map(existingViolations.map((v) => [v.merchant_name, v]));

    // 预加载 user_merchants 用于匹配
    const allUserMerchants = await prisma.user_merchants.findMany({
      where: { is_deleted: 0 },
      select: { id: true, merchant_name: true, merchant_url: true, violation_status: true },
    });

    // 按批次处理违规记录
    const BATCH_SIZE = 200;
    for (let i = 0; i < violations.length; i += BATCH_SIZE) {
      const batch = violations.slice(i, i + BATCH_SIZE);
      if (i % 1000 === 0) {
        syncState.progress = `正在同步违规商家 ${i}/${vioTotal}…`;
      }

      for (const v of batch) {
        let vtime: Date | null = null;
        if (v.time) {
          const raw = v.time.trim();
          if (/^\d{8}$/.test(raw)) vtime = new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`);
          else { const d = new Date(raw); if (!isNaN(d.getTime())) vtime = d; }
        }

        const exists = existingMap.get(v.name);
        if (exists) {
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
          vioUpdated++;
        } else {
          const created = await prisma.merchant_violations.create({
            data: {
              merchant_name: v.name, platform: v.platform, merchant_domain: v.domain || null,
              violation_reason: v.reason, violation_time: vtime, source: v.source || null, upload_batch: vioBatch,
            },
          });
          existingMap.set(v.name, { id: created.id, merchant_name: v.name, platform: v.platform, merchant_domain: v.domain || null, violation_time: vtime, source: v.source || null });
          vioNew++;
        }

        // 在内存中匹配 user_merchants
        const baseName = stripCountrySuffix(v.name);
        const nameL = v.name.toLowerCase();
        const baseL = baseName.toLowerCase();
        const basePrefix = baseL + " ";
        const toMark = allUserMerchants.filter((m) => {
          if (m.violation_status === "violated") return false;
          const mn = (m.merchant_name || "").toLowerCase();
          if (mn === nameL) return true;
          if (baseName !== v.name && mn === baseL) return true;
          if (mn.startsWith(basePrefix)) return true;
          if (v.domain && m.merchant_url && m.merchant_url.includes(v.domain)) return true;
          return false;
        });
        if (toMark.length > 0) {
          await prisma.user_merchants.updateMany({
            where: { id: { in: toMark.map((m) => m.id) } },
            data: { violation_status: "violated", violation_time: vtime || new Date() },
          });
          for (const m of toMark) m.violation_status = "violated";
          vioMarked += toMark.length;
        }
      }
    }
    log(`Violations done: ${vioNew} new, ${vioUpdated} updated, ${vioMarked} marked`);
  } catch (e: any) {
    vioError = e?.message || String(e);
    log(`Violation sync error: ${vioError}`);
  }

  // ── 同步推荐商家（批量优化） ──
  let recTotal = recommendations.length, recNew = 0, recSkipped = 0, recMarked = 0;
  let recError: string | null = null;
  try {
    syncState.progress = `正在同步 ${recTotal} 条推荐商家…`;
    log(`Syncing ${recTotal} recommendations...`);
    const recBatch = `SHEET-REC-${batchTs}`;

    const existingRecs = await prisma.merchant_recommendations.findMany({
      where: { is_deleted: 0 },
      select: { merchant_name: true },
    });
    const existingRecNames = new Set(existingRecs.map((r) => r.merchant_name));

    for (const r of recommendations) {
      if (existingRecNames.has(r.name)) { recSkipped++; continue; }

      await prisma.merchant_recommendations.create({
        data: {
          merchant_name: r.name, roi_reference: r.roi || null, commission_info: r.commission || null,
          settlement_info: r.settlement || null, remark: r.remark || null, share_time: r.time || null, upload_batch: recBatch,
        },
      });
      existingRecNames.add(r.name);
      recNew++;

      const matched = await prisma.user_merchants.findMany({
        where: { is_deleted: 0, merchant_name: { equals: r.name }, recommendation_status: { not: "recommended" } },
        select: { id: true },
      });
      if (matched.length > 0) {
        await prisma.user_merchants.updateMany({
          where: { id: { in: matched.map((m) => m.id) } },
          data: { recommendation_status: "recommended", recommendation_time: new Date(), violation_status: "normal", violation_time: null },
        });
        recMarked += matched.length;
      }
    }
    log(`Recommendations done: ${recNew} new, ${recSkipped} skipped, ${recMarked} marked`);
  } catch (e: any) {
    recError = e?.message || String(e);
    log(`Recommendation sync error: ${recError}`);
  }

  // 更新同步时间
  if (!vioError || !recError) {
    await prisma.sheet_configs.update({ where: { id: cfgId }, data: { last_synced_at: new Date() } });
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const result = {
    violation: { total: vioTotal, new: vioNew, updated: vioUpdated, marked: vioMarked, error: vioError },
    recommendation: { total: recTotal, new: recNew, skipped: recSkipped, marked: recMarked, error: recError },
  };

  syncState.running = false;
  syncState.result = result;
  syncState.error = (vioError && recError) ? `违规: ${vioError} | 推荐: ${recError}` : null;
  syncState.progress = (vioError && recError) ? "同步失败" : "同步完成";

  log(`Sync completed in ${elapsed}s — VIO: ${vioNew} new / ${vioUpdated} upd / ${vioMarked} marked | REC: ${recNew} new / ${recSkipped} skip / ${recMarked} marked`);
}
