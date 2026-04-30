/**
 * 今日投放商家 — Google Sheet 读取与解析
 *
 * 数据来源：每个 MCC 账户的 sheet_url（CampaignInfo Tab）
 * 逻辑：筛出 CreationDateCST = 今日CST 的行（即今天创建的广告系列）
 *       通过 google_campaign_id 关联 campaigns 表，按 user_id 统计去重商家数
 *       对不走 CRM 建系列的成员同样有效（Google Ads Script 会导出全部系列）
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
 * 解析 CampaignInfo 表，返回今日（CST）创建的 campaign ID 集合
 * 列结构：CampaignId | CampaignName | Status | CreationDateCST | CustomerId
 * CreationDateCST 由脚本将账户时区的 creation_time 转为 Asia/Shanghai 日期
 */
function parseCampaignInfoRows(rows: string[][], todayStr: string): Set<string> {
  if (rows.length < 2) return new Set();

  const headers = rows[0].map((h) => h.trim());
  const campaignIdIdx = headers.indexOf("CampaignId");
  const creationDateIdx = headers.indexOf("CreationDateCST");

  if (campaignIdIdx < 0 || creationDateIdx < 0) return new Set();

  const result = new Set<string>();
  for (const row of rows.slice(1)) {
    const creationDate = (row[creationDateIdx] ?? "").trim();
    if (creationDate !== todayStr) continue;
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

      // 查找 CampaignInfo tab（名称可能有大小写变体）
      const tabs = await getSheetTabs(sheetId, token);
      const infoTab = tabs.find((t) => t.toLowerCase() === "campaigninfo") ?? "CampaignInfo";

      // CampaignInfo tab 数据量小（每系列一行，无日期维度），取前 5000 行足够
      const rows = await fetchSheetValues(sheetId, infoTab, token, "A1:E5000");
      const campaignIds = parseCampaignInfoRows(rows, todayStr);

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
