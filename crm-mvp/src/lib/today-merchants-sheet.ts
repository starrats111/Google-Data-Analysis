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

/**
 * CampaignInfo 读取故障类型（统一脚本没铺好的四种形态）。
 * MISSING_TAB 含两种：HTTP 400（tab 真的不存在）与 HTTP 200 但表头认不出
 * ——后者是 gviz 在 tab 不存在时回退到第一个 tab，此前一路静默当成「读到了但没今日行」。
 */
export type SheetIssueKind = "MISSING_TAB" | "EMPTY_SHEET" | "PERM_DENIED" | "BAD_URL";

export interface SheetIssue {
  mccId: string;
  mccName: string | null;
  userId: string;
  kind: SheetIssueKind;
  /** 原始错误信息（PERM_DENIED 等），供日志与飞书用 */
  detail: string;
}

/** CampaignInfo 单行（近两日 CST 创建的系列） */
export interface CampaignInfoRow {
  campaignId: string;
  campaignName: string;
  status: string;
  creationDate: string; // YYYY-MM-DD (CST)
  customerId: string;
  /** D-264：Budget 列（账户币种金额，已从 micros 换算）。老脚本无此列 / 空值 → null */
  budget: number | null;
}

/**
 * 解析 CampaignInfo 表的全部行（不做日期过滤，日期筛选由调用方按需做）。
 * 列结构：CampaignId | CampaignName | Status | CreationDateCST | CustomerId | Budget(可选)
 * CreationDateCST 由脚本将账户时区的 creation_time 转为 Asia/Shanghai 日期。
 *
 * D-285：hasBudgetCol 区分脚本新旧（新脚本=D-264 加了 Budget 列）。
 * null = 表头不是 CRM CampaignInfo 结构（jy 组另类表等），新旧无从判定。
 */
function parseCampaignInfoRows(rows: string[][]): { list: CampaignInfoRow[]; hasBudgetCol: boolean | null; headerOk: boolean } {
  // rows.length === 1（只有表头）不再当成解析失败：交给调用方判为 EMPTY_SHEET
  if (rows.length === 0) return { list: [], hasBudgetCol: null, headerOk: false };

  const headers = rows[0].map((h) => h.trim());
  const campaignIdIdx = headers.indexOf("CampaignId");
  const nameIdx = headers.indexOf("CampaignName");
  const statusIdx = headers.indexOf("Status");
  const creationDateIdx = headers.indexOf("CreationDateCST");
  const customerIdx = headers.indexOf("CustomerId");
  const budgetIdx = headers.indexOf("Budget");

  // 表头认不出 = gviz 在 CampaignInfo tab 不存在时回退到了第一个 tab（HTTP 200，非 400）
  if (campaignIdIdx < 0 || creationDateIdx < 0) return { list: [], hasBudgetCol: null, headerOk: false };

  const result: CampaignInfoRow[] = [];
  for (const row of rows.slice(1)) {
    const creationDate = (row[creationDateIdx] ?? "").trim();
    const campaignId = (row[campaignIdIdx] ?? "").trim();
    if (!campaignId) continue;

    let budget: number | null = null;
    if (budgetIdx >= 0) {
      const raw = (row[budgetIdx] ?? "").trim();
      const micros = raw === "" || raw === "--" ? NaN : parseFloat(raw.replace(/,/g, ""));
      if (!isNaN(micros) && micros > 0) budget = micros / 1_000_000;
    }

    result.push({
      campaignId,
      campaignName: nameIdx >= 0 ? (row[nameIdx] ?? "").trim() : "",
      status: statusIdx >= 0 ? (row[statusIdx] ?? "").trim() : "",
      creationDate,
      // 与 sheet-status-sync 口径一致：去横杠存纯数字，否则 CID 计数/换链按 customer_id 匹配会失效
      customerId: customerIdx >= 0 ? (row[customerIdx] ?? "").trim().replace(/-/g, "") : "",
      budget,
    });
  }
  return { list: result, hasBudgetCol: budgetIdx >= 0, headerOk: true };
}

export interface TodayMerchantsResult {
  /** user_id → 今日投放商家数 */
  byUser: Map<string, number>;
  /** 近两日新建系列行明细（供快速回填新广告进 campaigns 表），带归属 user/mcc */
  recentRows: Array<CampaignInfoRow & { userId: string; mccDbId: string }>;
  /**
   * D-225：userId → (gcid → Sheet 当前系列名)，CampaignInfo **全量**行。
   * 供改名回写：Google 后台改名后 30 分钟内同步回 CRM，不再等每日 daily-sync。
   * CampaignInfo 是全量清单，连「已暂停无花费的系列被改名」也能捕捉
   * （daily-sync 走 DailyData + 近 3 天闸门，看不到这类行）。
   */
  nameByUserGcid: Map<string, Map<string, string>>;
  /**
   * D-264：userId → (gcid → Sheet Budget，账户币种)，CampaignInfo 全量行。
   * 供预算回写：DailyData 只有「有展示的天」才落行，零花费/停投系列的预算
   * 只能靠这张全量清单刷新——否则永远停在建单初值（yz01 $2 案例的病根之一）。
   */
  budgetByUserGcid: Map<string, Map<string, number>>;
  /**
   * D-285：mccDbId → 脚本新旧检测结果（hasBudgetCol=false 即旧脚本，需换）。
   * 只收录 CampaignInfo 表头可识别的 MCC；另类表结构（jy 组）不在其中。
   * 消费方：today-merchants-sync 落库标记 + 旧脚本定向弹窗；budget-fix 接口读标记做闸门。
   */
  scriptStatusByMcc: Map<string, { mccId: string; mccName: string | null; userId: string; hasBudgetCol: boolean }>;
  /**
   * mccDbId → CampaignInfo 读取故障。消费方：today-merchants-sync 定向弹窗催归属人修脚本。
   * 有故障的 MCC 对「今日投放数」贡献恒为 0，此前只有 HTTP 400/403 两种会进 errors，
   * 表头不对与空表（生产实测 15 个）完全静默——成员只看到数字偏小，无从知道是哪个 MCC。
   */
  sheetIssueByMcc: Map<string, SheetIssue>;
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
      mcc_name: true,
      sheet_url: true,
    },
  });

  mccCount = mccs.length;

  // 2. 按 MCC 读取 Sheet CampaignInfo，收集近两日新建系列（今日行计数 + 全部行供回填）
  const userCampaignIds = new Map<string, Set<string>>();
  const recentRows: TodayMerchantsResult["recentRows"] = [];
  const nameByUserGcid: TodayMerchantsResult["nameByUserGcid"] = new Map();
  const budgetByUserGcid: TodayMerchantsResult["budgetByUserGcid"] = new Map();
  const scriptStatusByMcc: TodayMerchantsResult["scriptStatusByMcc"] = new Map();
  const sheetIssueByMcc: TodayMerchantsResult["sheetIssueByMcc"] = new Map();

  for (const mcc of mccs) {
    if (!mcc.sheet_url) continue;

    const mccDbId = String(mcc.id);
    const userId = String(mcc.user_id);
    const recordIssue = (kind: SheetIssueKind, note: string) => {
      sheetIssueByMcc.set(mccDbId, { mccId: mcc.mcc_id, mccName: mcc.mcc_name, userId, kind, detail: note });
      errors.push(`MCC ${mcc.mcc_id} [${kind}]: ${note}`);
    };

    const sheetId = extractSheetId(mcc.sheet_url);
    if (!sheetId) {
      recordIssue("BAD_URL", "无效 sheet_url");
      continue;
    }

    try {
      // readSheetCsv：Tab 不存在时返回 []（HTTP 400 静默），权限不足抛错
      const rows = await readSheetCsv(sheetId, "CampaignInfo");
      if (rows.length === 0) {
        recordIssue("MISSING_TAB", "sheet 缺 CampaignInfo tab（需 Google Ads Script 生成）");
        continue;
      }
      const parsed = parseCampaignInfoRows(rows);
      if (!parsed.headerOk) {
        // HTTP 200 但读到的不是 CampaignInfo——gviz 在 tab 不存在时回退到第一个 tab。
        // 此前这里一路当成「读到了、只是没有今日行」，静默贡献 0（生产实测 11 个 MCC）。
        const got = (rows[0] || []).slice(0, 3).join(" / ").slice(0, 60);
        recordIssue("MISSING_TAB", `sheet 缺 CampaignInfo tab（实际读到另一张表：${got}）`);
        continue;
      }
      if (parsed.list.length === 0) {
        // 表头对但一条系列都没有：脚本装了没跑 / 跑失败（生产实测 4 个 MCC）
        recordIssue("EMPTY_SHEET", "CampaignInfo tab 只有表头、无任何系列（统一脚本未运行或运行失败）");
        if (parsed.hasBudgetCol != null) {
          scriptStatusByMcc.set(mccDbId, {
            mccId: mcc.mcc_id, mccName: mcc.mcc_name, userId, hasBudgetCol: parsed.hasBudgetCol,
          });
        }
        continue;
      }
      const allRows = parsed.list;
      // D-285：表头可识别才记录脚本新旧；另类结构（jy 组）不判定不弹
      if (parsed.hasBudgetCol != null) {
        scriptStatusByMcc.set(mccDbId, {
          mccId: mcc.mcc_id, mccName: mcc.mcc_name, userId, hasBudgetCol: parsed.hasBudgetCol,
        });
      }
      const parsedRows = allRows.filter((r) => recentDates.has(r.creationDate));

      const todayRows = parsedRows.filter((r) => r.creationDate === todayStr);
      if (todayRows.length > 0) {
        mccWithData++;
        if (!userCampaignIds.has(userId)) userCampaignIds.set(userId, new Set());
        for (const r of todayRows) userCampaignIds.get(userId)!.add(r.campaignId);
      }
      for (const r of parsedRows) recentRows.push({ ...r, userId, mccDbId });

      // D-225：全量行进名字映射（同 gcid 出现在多张 Sheet 时先到先得，与回填去重口径一致）
      if (!nameByUserGcid.has(userId)) nameByUserGcid.set(userId, new Map());
      const nameMap = nameByUserGcid.get(userId)!;
      // D-264：全量行进预算映射（口径同上），零花费/停投系列的预算也能半小时级刷新
      if (!budgetByUserGcid.has(userId)) budgetByUserGcid.set(userId, new Map());
      const budgetMap = budgetByUserGcid.get(userId)!;
      for (const r of allRows) {
        if (r.campaignName && !nameMap.has(r.campaignId)) nameMap.set(r.campaignId, r.campaignName);
        if (r.budget != null && !budgetMap.has(r.campaignId)) budgetMap.set(r.campaignId, r.budget);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("权限不足")) {
        recordIssue("PERM_DENIED", msg.slice(0, 200));
      } else {
        // 网络超时等瞬态失败不登记故障、不弹窗（质量闸：不确定 ≠ 危险，防狼来了），仅进日志
        errors.push(`MCC ${mcc.mcc_id}: ${msg.slice(0, 200)}`);
      }
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

  return { byUser, recentRows, nameByUserGcid, budgetByUserGcid, scriptStatusByMcc, sheetIssueByMcc, mccCount, mccWithData, date: todayStr, errors };
}
