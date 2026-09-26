/**
 * D-360：Sheet 通道健康体检 + 管理员日报（承 D-359）
 *
 * 缘起：D-359 修完 CID_List 吞行后顺手全量体检，发现 60 个配了 Sheet 的 MCC 里
 * **26 个的通道是坏的**（403 拒访 4、410 表被删 2、200 空响应 7、表头在无数据 3、
 * 根本没有 CID_List tab 10），它们名下库内标着 ENABLED 的广告有 1153 条，
 * 而通道正常的 MCC 只有 820 条——也就是说界面上大半的「在投」是没人核实过的冻结值，
 * 最久的（669-998-7223）停在 2026-06-30，冻了快三个月。
 *
 * 关键是：**告警其实一直在发**。CampaignInfo 的四类故障（D-285 notifyCampaignInfoIssue）、
 * Sheet 被封/结构不符（broadcastSheetFailure）、脚本停更（checkSheetScriptFreshness）
 * 都按周推给了 MCC 归属人。查库确认近 30 天真的发出去了十几条。所以缺的不是"再加一个告警"。
 *
 * 真正的两个洞：
 *
 * ① **越坏越久，越没人知道**。上面那些告警都挂着 mccRecentlyActive 闸门
 *    （近 7 天 ads_daily_stats 无数据就不弹，防上线首轮 20 条风暴）。闸门注释把
 *    「数据断流超窗 → 自动停报」写成自愈特性，但对**通道坏导致数据断流**的 MCC 来说，
 *    这是故障自己把自己的告警关掉：坏得越久越安静。实测 26 个里有 11 个近 30 天
 *    一条告警都没发过（128-026-5662 最后花费 09-15、341-732-8198 停在 08-07），
 *    恰恰是坏得最久的那批。
 *
 * ② **没有全局视角**。D-269 的数据隔离让每条告警只发归属人，这对隔离是对的，
 *    但管理员那里从来没有一张「现在有几个通道是坏的」的总表——26 个分散在 11 个归属人
 *    手里各收各的，谁都看不出这是个系统性问题，于是三个月没人推动。
 *
 * 本模块的口径，刻意与既有告警区分，避免重复轰炸：
 * - **不发归属人**（那条链路已经有人负责，再发就是双报），只发**管理员汇总一条**；
 * - **不挂 mccRecentlyActive 闸门**——本体检存在的意义正是覆盖被那道闸门静音的陈年故障。
 *   汇总成一条日报所以不存在风暴问题，这也是敢摘闸门的前提；
 * - 只陈述**能证明的事实**（HTTP 状态、表头、行数、库内最后一次状态更新时间、最后有花费日），
 *   不编造"坏了多少天"——没有历史探测记录，那个数字推不出来，宁可不给。
 */
import prisma from "@/lib/prisma";
import { extractSheetId, readSheetCsv } from "@/lib/sheet-sync";
import { sendCriticalAlert } from "@/lib/system-broadcast";

/**
 * 通道状态。顺序即严重度（越靠前越该先修）。
 * - PERM_DENIED：403/权限不足，表还在但不给看（分享权限被改，或账号被封）
 * - GONE：410，表被删/进了回收站
 * - FETCH_FAIL：其它拉取失败（网络、5xx、超时）——瞬态可能性大，只记不催
 * - EMPTY_SHEET：HTTP 200 但 0 字节，整个表是空的（脚本停在 clearContents 之后，或表被清过）
 * - MISSING_TAB：读到的不是目标 tab——gviz 在 tab 不存在时**静默回退到第一张表**且照样 200，
 *   所以这类最容易被当成"读到了"，是本次体检里数量最大的一类（10 个）
 * - NO_DATA_ROWS：表头对，但一行数据都没有（脚本装了没跑起来）
 * - OK：表头对且有数据行
 */
export type ChannelState =
  | "OK"
  | "PERM_DENIED"
  | "GONE"
  | "FETCH_FAIL"
  | "EMPTY_SHEET"
  | "MISSING_TAB"
  | "NO_DATA_ROWS";

export const CHANNEL_STATE_LABEL: Record<ChannelState, string> = {
  OK: "正常",
  PERM_DENIED: "拒绝访问（403/权限不足）",
  GONE: "表已被删除（410）",
  FETCH_FAIL: "拉取失败",
  EMPTY_SHEET: "整个表是空的（200 但无内容）",
  MISSING_TAB: "没有这个 tab（gviz 回退到第一张表）",
  NO_DATA_ROWS: "只有表头、无数据行",
};

/** 每类故障该让人做什么——日报里直接带上，省得收到的人还要去翻文档 */
export const CHANNEL_STATE_ACTION: Record<ChannelState, string> = {
  OK: "",
  PERM_DENIED: "把该 Sheet 的共享改回「知道链接的任何人都可以查看」；若是账号被封，按被封流程处理",
  GONE: "表已不存在，需重建并到「设置 → MCC 账户」回填新链接",
  FETCH_FAIL: "多为瞬态，下轮体检若仍在列再查",
  EMPTY_SHEET: "到 Google Ads Scripts 看该 MCC 的脚本运行记录与报错，手动跑一次",
  MISSING_TAB: "该表不是统一脚本产出的（多半挂的是旧脚本），需重新生成统一脚本或改绑正确的表",
  NO_DATA_ROWS: "脚本装了但没跑出结果，到 Scripts 页手动运行一次看报错",
};

/** 判定一次 tab 探测的结果。纯函数，可单测。 */
export function classifyProbe(input: {
  /** readSheetCsv 抛出的错误信息（没抛就不传） */
  error?: string | null;
  /** readSheetCsv 返回的行（抛错时不传） */
  rows?: string[][] | null;
  /** 该 tab 的第一列列名（小写），用来判断读到的是不是目标 tab */
  wantFirstCol: string;
}): ChannelState {
  const err = input.error || "";
  if (err) {
    if (err.includes("权限不足") || err.includes("403") || err.includes("401")) return "PERM_DENIED";
    if (err.includes("410")) return "GONE";
    return "FETCH_FAIL";
  }
  const rows = input.rows || [];
  if (rows.length === 0) return "EMPTY_SHEET"; // 200 空响应，或 400 被 readSheetCsv 归一成 []
  // 表头首段匹配（与 cid-list-sheet-sync 的 findHeaderCol 同口径：吞行时列名后面会跟着值）
  const first = (rows[0]?.[0] ?? "").trim().toLowerCase().split(/[\s\r\n]+/)[0];
  if (first !== input.wantFirstCol) return "MISSING_TAB";
  return rows.length > 1 ? "OK" : "NO_DATA_ROWS";
}

export interface ChannelHealthRow {
  mccId: string;
  mccName: string | null;
  owner: string;
  cidList: ChannelState;
  /** 只在 CID_List 非 OK 时才探（正常的那批 CampaignInfo 由半小时链路负责，不重复拉） */
  campaignInfo: ChannelState | null;
  /** 库内标着 ENABLED 的系列数——通道坏时这些值是无人核实的冻结值，用来排优先级 */
  enabledCampaigns: number;
  /** 该 MCC 的系列状态最后一次被写库的时间（冻结起点的近似） */
  lastCampaignUpdate: Date | null;
  /** 最后有花费的日期：还在花钱 = 坏得最该急 */
  lastCostDate: string | null;
}

/** 严重度排序：先按"还在花钱且冻结的广告多"，再按状态严重度 */
const STATE_RANK: Record<ChannelState, number> = {
  PERM_DENIED: 0, GONE: 1, MISSING_TAB: 2, EMPTY_SHEET: 3, NO_DATA_ROWS: 4, FETCH_FAIL: 5, OK: 9,
};

export function rankChannelRows(rows: ChannelHealthRow[]): ChannelHealthRow[] {
  return [...rows].sort((a, b) => {
    if (b.enabledCampaigns !== a.enabledCampaigns) return b.enabledCampaigns - a.enabledCampaigns;
    return STATE_RANK[a.cidList] - STATE_RANK[b.cidList];
  });
}

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }) : "从未";

/** 日报正文（纯函数，可单测）。空列表返回 null = 今天没有坏的，不发通知。 */
export function formatChannelDigest(rows: ChannelHealthRow[], totalMccs: number): { title: string; content: string } | null {
  const broken = rows.filter((r) => r.cidList !== "OK");
  if (broken.length === 0) return null;
  const ranked = rankChannelRows(broken);
  const frozenAds = ranked.reduce((s, r) => s + r.enabledCampaigns, 0);

  const lines = ranked.map((r) => {
    // 没起过名的 MCC 库里 mcc_name 直接存的是 mcc_id，照模板拼会变成「280-992-0096（280-992-0096）」
    const label = r.mccName && r.mccName !== r.mccId ? `${r.mccName}（${r.mccId}）` : r.mccId;
    const ci = r.campaignInfo && r.campaignInfo !== r.cidList
      ? `，CampaignInfo=${CHANNEL_STATE_LABEL[r.campaignInfo]}`
      : (r.campaignInfo === r.cidList ? "，CampaignInfo 同样如此" : "");
    return `• ${label}｜归属 ${r.owner}｜${CHANNEL_STATE_LABEL[r.cidList]}${ci}\n`
      + `  　库内标在投 ${r.enabledCampaigns} 条，系列状态最后更新 ${fmtDate(r.lastCampaignUpdate)}，最后有花费 ${r.lastCostDate || "从未"}`;
  });

  const byState = new Map<ChannelState, number>();
  for (const r of ranked) byState.set(r.cidList, (byState.get(r.cidList) ?? 0) + 1);
  const summary = [...byState.entries()]
    .sort((a, b) => STATE_RANK[a[0]] - STATE_RANK[b[0]])
    .map(([s, n]) => `${CHANNEL_STATE_LABEL[s]} ${n} 个`)
    .join("、");

  const actions = [...byState.keys()]
    .sort((a, b) => STATE_RANK[a] - STATE_RANK[b])
    .map((s) => `· ${CHANNEL_STATE_LABEL[s]} → ${CHANNEL_STATE_ACTION[s]}`)
    .join("\n");

  return {
    title: `Sheet 通道体检：${broken.length}/${totalMccs} 个 MCC 的 CID_List 读不到`,
    content:
      `这些 MCC 的账户状态与广告系列状态同步已中断，界面上它们名下「在投 ${frozenAds} 条」是无人核实的冻结值，`
      + `广告在 Google 侧的真实状态与花费不受影响（钱照花）。\n`
      + `分类：${summary}\n\n`
      + `${lines.join("\n")}\n\n`
      + `怎么修：\n${actions}\n\n`
      + `（本条是管理员汇总，每天一条。归属人侧的单条告警由既有通道按周推送，两者不重复。`
      + `本体检刻意不挂「近 7 天有数据」闸门——正是那道闸门让坏得最久的 MCC 反而不再告警。）`,
  };
}

export interface ChannelHealthStats {
  checked: number;
  broken: number;
  frozenEnabledCampaigns: number;
  digestSent: boolean;
}

/** 每日体检入口（daily-sync 挂载）。永不抛异常：体检坏了不许弄坏主流程。 */
export async function checkSheetChannelHealth(log: (msg: string) => void): Promise<ChannelHealthStats> {
  const stats: ChannelHealthStats = { checked: 0, broken: 0, frozenEnabledCampaigns: 0, digestSent: false };

  const mccs = await prisma.google_mcc_accounts.findMany({
    where: { is_deleted: 0, sheet_url: { not: null } },
    select: { id: true, mcc_id: true, mcc_name: true, sheet_url: true, user_id: true },
  });

  const owners = await prisma.users.findMany({
    where: { id: { in: [...new Set(mccs.map((m) => m.user_id))] } },
    select: { id: true, username: true },
  });
  const ownerName = new Map(owners.map((u) => [u.id.toString(), u.username || `user${u.id}`]));

  const rows: ChannelHealthRow[] = [];

  for (const mcc of mccs) {
    stats.checked++;
    const sid = extractSheetId(mcc.sheet_url || "");
    let cidState: ChannelState;
    if (!sid) {
      cidState = "FETCH_FAIL"; // 链接里解析不出表格 ID，由 BAD_URL 那条链路催归属人
    } else {
      cidState = await probeTab(sid, "CID_List", "customerid");
    }
    if (cidState === "OK") continue;

    const ciState = sid ? await probeTab(sid, "CampaignInfo", "campaignid") : null;

    const [enabled, lastCampaign, lastCost] = await Promise.all([
      prisma.campaigns.count({ where: { mcc_id: mcc.id, is_deleted: 0, google_status: "ENABLED" } }),
      prisma.campaigns.aggregate({ where: { mcc_id: mcc.id, is_deleted: 0 }, _max: { updated_at: true } }),
      prisma.$queryRaw<Array<{ d: Date | null }>>`
        SELECT MAX(s.date) AS d FROM ads_daily_stats s
        JOIN campaigns c ON c.id = s.campaign_id
        WHERE c.mcc_id = ${mcc.id}`,
    ]);

    const d = lastCost[0]?.d;
    rows.push({
      mccId: mcc.mcc_id,
      mccName: mcc.mcc_name,
      owner: ownerName.get(mcc.user_id.toString()) || `user${mcc.user_id}`,
      cidList: cidState,
      campaignInfo: ciState,
      enabledCampaigns: enabled,
      lastCampaignUpdate: lastCampaign._max.updated_at ?? null,
      lastCostDate: d ? new Date(d).toISOString().slice(0, 10) : null,
    });
  }

  stats.broken = rows.length;
  stats.frozenEnabledCampaigns = rows.reduce((s, r) => s + r.enabledCampaigns, 0);

  for (const r of rankChannelRows(rows)) {
    log(`  [通道体检] ${r.mccName && r.mccName !== r.mccId ? `${r.mccName}(${r.mccId})` : r.mccId}（归属 ${r.owner}）: CID_List=${CHANNEL_STATE_LABEL[r.cidList]}`
      + `，库内标在投 ${r.enabledCampaigns} 条，最后有花费 ${r.lastCostDate || "从未"}`);
  }

  const digest = formatChannelDigest(rows, stats.checked);
  if (digest) {
    // 收件人留空 → resolveRecipients 兜底发全体管理员，正是本日报想要的收件范围
    stats.digestSent = await sendCriticalAlert({
      key: `sheet_channel_digest_${new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" })}`,
      userIds: [],
      dedupeHours: 20, // 每天一条；20h 而非 24h，免得日跑时间小幅漂移时漏发一天
      level: "warning",
      title: digest.title,
      content: digest.content,
    });
  }

  log(`  [通道体检] 共 ${stats.checked} 个 MCC，坏 ${stats.broken} 个，`
    + `其名下库内标在投 ${stats.frozenEnabledCampaigns} 条（冻结值）${stats.digestSent ? "，已发管理员日报" : ""}`);
  return stats;
}

async function probeTab(sid: string, tab: string, wantFirstCol: string): Promise<ChannelState> {
  try {
    const rows = await readSheetCsv(sid, tab);
    return classifyProbe({ rows, wantFirstCol });
  } catch (e) {
    return classifyProbe({ error: e instanceof Error ? e.message : String(e), wantFirstCol });
  }
}
