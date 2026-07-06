/**
 * 广告系列状态同步 — 数据源为 Google Sheet（CampaignInfo Tab），不打 Google Ads API。
 *
 * 背景：旧版页面加载即通过 refresh-status 走 Google Ads API 全量扫描所有 CID
 * （每人每次打开数据中心 = 上百次 GAQL 查询），把共享 Developer Token 的
 * explorer 配额打爆，全员广告提交频繁 429。而 Google Ads 统一脚本本来就在
 * 持续把全量系列的最新状态写进 Sheet 的 CampaignInfo 表
 * （CampaignId | CampaignName | Status | CreationDateCST | CustomerId），
 * 读 Sheet CSV 导出即可，零 API 配额消耗。
 *
 * 语义与旧 status-sync 对齐：
 * - google_status 与内部 status 同步刷新（PAUSED/REMOVED → paused，其余 → active）
 * - customer_id 缺失时回填
 * - Sheet 中不存在的系列一律不动（可能是脚本未跑完/新 MCC 未配 Sheet，宁可不改）
 * - 不在此处创建新系列（新系列回填由 today-merchants-sync 每 30 分钟负责）
 */
import prisma from "@/lib/prisma";
import { readSheetCsv, extractSheetId } from "@/lib/sheet-sync";
import { syncMerchantStatusForUser } from "@/lib/campaign-merchant-link";

interface SheetSyncResult {
  mcc: string;
  campaigns: number;
  updated: number;
  new_campaigns: number;
  error?: string;
}

export interface SheetCampaignStatus {
  status: string;
  name: string;
  customerId: string;
}

const VALID_STATUSES = new Set(["ENABLED", "PAUSED", "REMOVED"]);

/** 解析 CampaignInfo 全部行：gcid → { status, name, customerId } */
function parseAllCampaignInfoRows(rows: string[][]): Map<string, SheetCampaignStatus> {
  const map = new Map<string, SheetCampaignStatus>();
  if (rows.length < 2) return map;

  const headers = rows[0].map((h) => h.trim());
  const idIdx = headers.indexOf("CampaignId");
  const nameIdx = headers.indexOf("CampaignName");
  const statusIdx = headers.indexOf("Status");
  const customerIdx = headers.indexOf("CustomerId");
  if (idIdx < 0 || statusIdx < 0) return map;

  for (const row of rows.slice(1)) {
    const gcid = (row[idIdx] ?? "").trim();
    if (!gcid) continue;
    const status = (row[statusIdx] ?? "").trim().toUpperCase();
    if (!VALID_STATUSES.has(status)) continue;
    map.set(gcid, {
      status,
      name: nameIdx >= 0 ? (row[nameIdx] ?? "").trim() : "",
      customerId: customerIdx >= 0 ? (row[customerIdx] ?? "").trim().replace(/-/g, "") : "",
    });
  }
  return map;
}

/**
 * 读取某 MCC Sheet 的 CampaignInfo 全量状态。
 * 返回 null 表示「无法取得数据」（未配 sheet_url / 缺 CampaignInfo tab / 无有效行），
 * 调用方应跳过该 MCC 的状态同步（宁可不改，不能当作"全部系列已消失"）。
 */
export async function readCampaignInfoStatuses(
  sheetUrl: string | null,
): Promise<Map<string, SheetCampaignStatus> | null> {
  const sheetId = sheetUrl ? extractSheetId(sheetUrl) : null;
  if (!sheetId) return null;
  const rows = await readSheetCsv(sheetId, "CampaignInfo");
  if (rows.length === 0) return null;
  const map = parseAllCampaignInfoRows(rows);
  return map.size > 0 ? map : null;
}

/**
 * 从各 MCC 配置的 Google Sheet（CampaignInfo）同步当前用户全部广告系列状态。
 * 返回结构与旧 syncUserCampaignStatuses 兼容（new_campaigns 恒为 0）。
 */
export async function syncUserCampaignStatusesFromSheet(userId: bigint): Promise<SheetSyncResult[]> {
  const mccs = await prisma.google_mcc_accounts.findMany({
    where: { user_id: userId, is_deleted: 0, is_active: 1 },
    select: { id: true, mcc_id: true, mcc_name: true, sheet_url: true },
  });

  const results: SheetSyncResult[] = [];
  let anyChange = false;

  for (const mcc of mccs) {
    const label = mcc.mcc_name || mcc.mcc_id;

    try {
      const sheetMap = await readCampaignInfoStatuses(mcc.sheet_url);
      if (!sheetMap) {
        results.push({
          mcc: label, campaigns: 0, updated: 0, new_campaigns: 0,
          error: mcc.sheet_url
            ? "Sheet 缺 CampaignInfo tab 或无有效数据（需 Google Ads 统一脚本生成）"
            : "未配置 Google Sheet",
        });
        continue;
      }

      const existing = await prisma.campaigns.findMany({
        where: { user_id: userId, mcc_id: mcc.id, is_deleted: 0, google_campaign_id: { not: null } },
        select: { id: true, google_campaign_id: true, google_status: true, status: true, customer_id: true },
      });

      let updated = 0;
      for (const c of existing) {
        const sheetRow = sheetMap.get(c.google_campaign_id!);
        if (!sheetRow) continue; // Sheet 里没有的系列不动

        const expectedInternal = sheetRow.status === "PAUSED" || sheetRow.status === "REMOVED" ? "paused" : "active";
        const statusChanged = c.google_status !== sheetRow.status;
        const internalDrifted = c.status !== expectedInternal;
        const cidFilling = !c.customer_id && sheetRow.customerId;
        if (!statusChanged && !internalDrifted && !cidFilling) continue;

        const data: Record<string, unknown> = { last_google_sync_at: new Date() };
        if (statusChanged) data.google_status = sheetRow.status;
        if (statusChanged || internalDrifted) data.status = expectedInternal;
        if (cidFilling) data.customer_id = sheetRow.customerId;
        await prisma.campaigns.update({ where: { id: c.id }, data });
        updated++;
      }

      if (updated > 0) anyChange = true;
      results.push({ mcc: label, campaigns: sheetMap.size, updated, new_campaigns: 0 });
    } catch (e) {
      results.push({
        mcc: label, campaigns: 0, updated: 0, new_campaigns: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 商家状态强关联同步（DB 内操作，与旧流程一致；仅在有变化时执行避免无谓写放大）
  if (anyChange) {
    const { linked, merchantsUpdated } = await syncMerchantStatusForUser(userId);
    if (linked > 0 || merchantsUpdated > 0) {
      console.log(`[SheetStatusSync] 商家同步：关联 ${linked} 条，状态更新 ${merchantsUpdated} 个`);
    }
  }

  return results;
}
