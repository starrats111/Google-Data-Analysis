/**
 * 今日投放商家 — Google Sheet 读取与解析
 *
 * 数据来源：每个 MCC 账户的 sheet_url（DailyData Tab）
 * 逻辑：筛出 Date = 今日CST、Status = ENABLED（无 Status 列则取全部）的行
 *       通过 google_campaign_id 关联 campaigns 表，按 user_id 统计去重商家数
 */
import { JWT } from "google-auth-library";
import prisma from "@/lib/prisma";
import { todayCST } from "@/lib/date-utils";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

// 每个 MCC 独立的 token 缓存（key = mcc DB id）
const tokenCache = new Map<string, { token: string; expiry: number }>();

async function getTokenForMcc(mccId: string, saJson: string): Promise<string> {
  const cached = tokenCache.get(mccId);
  if (cached && Date.now() < cached.expiry - 60_000) return cached.token;

  const sa = JSON.parse(saJson);
  const jwt = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: [SHEETS_SCOPE],
  });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error(`MCC ${mccId}: 无法获取 Google Sheets token`);
  tokenCache.set(mccId, { token, expiry: Date.now() + 3_500_000 });
  return token;
}

function extractSheetId(url: string): string | null {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

async function fetchSheetValues(
  sheetId: string,
  tabName: string,
  token: string,
  range = "A1:P2000"
): Promise<string[][]> {
  const url = `${SHEETS_API}/${sheetId}/values/${encodeURIComponent(`${tabName}!${range}`)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Sheets API ${resp.status}: ${body.slice(0, 200)}`);
  }
  const json = (await resp.json()) as { values?: string[][] };
  return json.values ?? [];
}

async function getSheetTabs(sheetId: string, token: string): Promise<string[]> {
  const url = `${SHEETS_API}/${sheetId}?fields=sheets.properties.title`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return [];
  const json = (await resp.json()) as { sheets?: { properties: { title: string } }[] };
  return (json.sheets ?? []).map((s) => s.properties.title);
}

/**
 * 从数据行中找出最新日期（不早于 cutoffDate）
 * 脚本写入的是近90天含今日数据，取最新一天作为"当前投放"的基准
 */
function findLatestDate(rows: string[][], dateIdx: number, cutoffDate: string): string | null {
  let latest: string | null = null;
  for (const row of rows.slice(1)) {
    const d = (row[dateIdx] ?? "").trim();
    if (!d || d < cutoffDate) continue; // 忽略 3 天以前的数据
    if (!latest || d > latest) latest = d;
  }
  return latest;
}

/**
 * 解析一张 DailyData 表，返回最新日期中启用的 campaign ID 集合
 * 使用最新可用日期（而非严格今日），兼容脚本在不同时段写入的情况
 */
function parseDailyDataRows(rows: string[][], todayStr: string): Set<string> {
  if (rows.length < 2) return new Set();

  const headers = rows[0].map((h) => h.trim());
  const dateIdx = headers.indexOf("Date");
  const statusIdx = headers.indexOf("Status");
  const campaignIdIdx = headers.indexOf("CampaignId");

  if (dateIdx < 0 || campaignIdIdx < 0) return new Set();

  // 取最近 3 天内的最新日期（允许今日或昨日数据）
  const threeDaysAgo = new Date(todayStr);
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  const cutoff = threeDaysAgo.toISOString().slice(0, 10);
  const latestDate = findLatestDate(rows, dateIdx, cutoff);
  if (!latestDate) return new Set(); // 3 天内无数据

  const hasStatus = statusIdx >= 0;
  const result = new Set<string>();

  for (const row of rows.slice(1)) {
    const rowDate = (row[dateIdx] ?? "").trim();
    if (rowDate !== latestDate) continue;

    // 无 Status 列 → 取全部行；有 Status 列 → 只取 ENABLED
    if (hasStatus) {
      const status = (row[statusIdx] ?? "").trim().toUpperCase();
      if (status !== "ENABLED") continue;
    }

    const campaignId = (row[campaignIdIdx] ?? "").trim();
    if (campaignId) result.add(campaignId);
  }

  return result;
}

export interface TodayMerchantsResult {
  /** user_id → 今日投放商家数 */
  byUser: Map<string, number>;
  /** 参与同步的 MCC 数量 */
  mccCount: number;
  /** 有数据的 MCC 数量 */
  mccWithData: number;
  /** 今日 CST 日期字符串 */
  date: string;
  errors: string[];
}

/**
 * 主函数：遍历所有配置了 sheet_url 的 MCC，统计今日投放商家数（按 user_id 汇总）
 */
export async function fetchTodayMerchantsFromSheets(): Promise<TodayMerchantsResult> {
  const todayStr = todayCST(); // YYYY-MM-DD
  const errors: string[] = [];
  let mccCount = 0;
  let mccWithData = 0;

  // 1. 读取所有有 sheet_url + service_account_json 的 MCC
  const mccs = await prisma.google_mcc_accounts.findMany({
    where: {
      is_deleted: 0,
      sheet_url: { not: null },
      service_account_json: { not: null },
    },
    select: {
      id: true,
      user_id: true,
      mcc_id: true,
      sheet_url: true,
      service_account_json: true,
    },
  });

  mccCount = mccs.length;

  // 2. 按 MCC 读取 Sheet，收集今日 Campaign IDs（user_id → Set<campaignId>）
  const userCampaignIds = new Map<string, Set<string>>();

  for (const mcc of mccs) {
    if (!mcc.sheet_url || !mcc.service_account_json) continue;

    const sheetId = extractSheetId(mcc.sheet_url);
    if (!sheetId) {
      errors.push(`MCC ${mcc.mcc_id}: 无效 sheet_url`);
      continue;
    }

    const mccDbId = String(mcc.id);
    const userId = String(mcc.user_id);

    try {
      const token = await getTokenForMcc(mccDbId, mcc.service_account_json);

      // 查找 DailyData tab（名称可能有大小写变体）
      const tabs = await getSheetTabs(sheetId, token);
      const dailyTab = tabs.find((t) => t.toLowerCase() === "dailydata") ?? "DailyData";

      const rows = await fetchSheetValues(sheetId, dailyTab, token);
      const campaignIds = parseDailyDataRows(rows, todayStr);

      if (campaignIds.size > 0) {
        mccWithData++;
        if (!userCampaignIds.has(userId)) userCampaignIds.set(userId, new Set());
        for (const cid of campaignIds) userCampaignIds.get(userId)!.add(cid);
      }
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

  return { byUser, mccCount, mccWithData, date: todayStr, errors };
}
