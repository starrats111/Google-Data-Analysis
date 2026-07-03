/**
 * 今日投放商家 + 新广告快速回填 — Google Sheet CampaignInfo 读取与解析
 *
 * 数据来源：每个 MCC 账户的 sheet_url（CampaignInfo Tab）
 * 读取方式：公开 CSV 导出链接（gviz/tq，与 sheet-sync 读 DailyData 同通道）。
 *   ⚠️ 此前走 Sheets API + SA token，但所有 SA 项目均未启用 Sheets API，
 *   33 个 MCC 全部 403（today_merchants 长期为 0）——CSV 导出无需 API/授权，一并根治。
 * 逻辑：筛出 CreationDateCST ∈ {今日, 昨日}（CST）的行（近两日新建系列）
 *       今日行用于统计投放商家数；全部行供 today-merchants-sync 快速回填 campaigns
 *       对不走 CRM 建系列的成员同样有效（Google Ads Script 会导出全部系列）
 */
import prisma from "@/lib/prisma";
import { todayCST } from "@/lib/date-utils";
import { readSheetCsv, extractSheetId } from "@/lib/sheet-sync";

/** CampaignInfo 单行（近两日 CST 创建的系列） */
export interface CampaignInfoRow {
  campaignId: string;
  campaignName: string;
  status: string;
  creationDate: string; // YYYY-MM-DD (CST)
  customerId: string;
}

/**
 * 解析 CampaignInfo 表，返回「近两日（今日+昨日 CST）创建」的 campaign 行明细。
 * 列结构：CampaignId | CampaignName | Status | CreationDateCST | CustomerId
 * CreationDateCST 由脚本将账户时区的 creation_time 转为 Asia/Shanghai 日期。
 * 含昨日：跨午夜/脚本延迟写入的行也能被回填，不会漏在两轮 cron 之间。
 */
function parseCampaignInfoRows(rows: string[][], recentDates: Set<string>): CampaignInfoRow[] {
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => h.trim());
  const campaignIdIdx = headers.indexOf("CampaignId");
  const nameIdx = headers.indexOf("CampaignName");
  const statusIdx = headers.indexOf("Status");
  const creationDateIdx = headers.indexOf("CreationDateCST");
  const customerIdx = headers.indexOf("CustomerId");

  if (campaignIdIdx < 0 || creationDateIdx < 0) return [];

  const result: CampaignInfoRow[] = [];
  for (const row of rows.slice(1)) {
    const creationDate = (row[creationDateIdx] ?? "").trim();
    if (!recentDates.has(creationDate)) continue;
    const campaignId = (row[campaignIdIdx] ?? "").trim();
    if (!campaignId) continue;
    result.push({
      campaignId,
      campaignName: nameIdx >= 0 ? (row[nameIdx] ?? "").trim() : "",
      status: statusIdx >= 0 ? (row[statusIdx] ?? "").trim() : "",
      creationDate,
      customerId: customerIdx >= 0 ? (row[customerIdx] ?? "").trim() : "",
    });
  }
  return result;
}

export interface TodayMerchantsResult {
  /** user_id → 今日投放商家数 */
  byUser: Map<string, number>;
  /** 近两日新建系列行明细（供快速回填新广告进 campaigns 表），带归属 user/mcc */
  recentRows: Array<CampaignInfoRow & { userId: string; mccDbId: string }>;
  /** 参与同步的 MCC 数量 */
  mccCount: number;
  /** 有数据的 MCC 数量 */
  mccWithData: number;
  /** 今日 CST 日期字符串 */
  date: string;
  errors: string[];
}

/**
 * 主函数：遍历所有配置了 sheet_url 的 MCC，读取 CampaignInfo：
 * 统计今日投放商家数（按 user_id 汇总）+ 收集近两日新建系列行（供快速回填）
 */
export async function fetchTodayMerchantsFromSheets(): Promise<TodayMerchantsResult> {
  const todayStr = todayCST(); // YYYY-MM-DD
  const yesterdayStr = new Date(new Date(`${todayStr}T00:00:00Z`).getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const recentDates = new Set([todayStr, yesterdayStr]);
  const errors: string[] = [];
  let mccCount = 0;
  let mccWithData = 0;

  // 1. 读取所有有 sheet_url 的 MCC（CSV 导出无需 service_account）
  const mccs = await prisma.google_mcc_accounts.findMany({
    where: {
      is_deleted: 0,
      sheet_url: { not: null },
    },
    select: {
      id: true,
      user_id: true,
      mcc_id: true,
      sheet_url: true,
    },
  });

  mccCount = mccs.length;

  // 2. 按 MCC 读取 Sheet CampaignInfo，收集近两日新建系列（今日行计数 + 全部行供回填）
  const userCampaignIds = new Map<string, Set<string>>();
  const recentRows: TodayMerchantsResult["recentRows"] = [];

  for (const mcc of mccs) {
    if (!mcc.sheet_url) continue;

    const sheetId = extractSheetId(mcc.sheet_url);
    if (!sheetId) {
      errors.push(`MCC ${mcc.mcc_id}: 无效 sheet_url`);
      continue;
    }

    const mccDbId = String(mcc.id);
    const userId = String(mcc.user_id);

    try {
      // readSheetCsv：Tab 不存在时返回 []（HTTP 400 静默），权限不足抛错
      const rows = await readSheetCsv(sheetId, "CampaignInfo");
      if (rows.length === 0) {
        errors.push(`MCC ${mcc.mcc_id} [MISSING_TAB]: sheet 缺 CampaignInfo tab（需 Google Ads Script 生成）`);
        continue;
      }
      const parsedRows = parseCampaignInfoRows(rows, recentDates);

      const todayRows = parsedRows.filter((r) => r.creationDate === todayStr);
      if (todayRows.length > 0) {
        mccWithData++;
        if (!userCampaignIds.has(userId)) userCampaignIds.set(userId, new Set());
        for (const r of todayRows) userCampaignIds.get(userId)!.add(r.campaignId);
      }
      for (const r of parsedRows) recentRows.push({ ...r, userId, mccDbId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`MCC ${mcc.mcc_id}: ${msg.slice(0, 200)}`);
    }
  }

  // 3. 关联 DB：google_campaign_id → user_merchant_id，按 user_id 去重统计
  const byUser = new Map<string, number>();

  for (const [userId, campaignIdSet] of userCampaignIds) {
    if (campaignIdSet.size === 0) continue;

    const campaignIdArr = Array.from(campaignIdSet);

    // 分批查询，避免 IN 子句过长（每批 500）
    const BATCH = 500;
    const merchantIds = new Set<string>();

    for (let i = 0; i < campaignIdArr.length; i += BATCH) {
      const batch = campaignIdArr.slice(i, i + BATCH);
      const rows = await prisma.campaigns.findMany({
        where: {
          google_campaign_id: { in: batch },
          user_id: BigInt(userId),
          is_deleted: 0,
        },
        select: { user_merchant_id: true },
      });
      for (const r of rows) merchantIds.add(String(r.user_merchant_id));
    }

    byUser.set(userId, merchantIds.size);
  }

  return { byUser, recentRows, mccCount, mccWithData, date: todayStr, errors };
}
