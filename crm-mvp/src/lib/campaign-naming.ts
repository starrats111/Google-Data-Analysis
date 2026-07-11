import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

type TxClient = Prisma.TransactionClient;

/* ────────────────────────────────────────────────────────────────────────────
 * 序号来源说明（2026-03-28 修正；2026-04-21 补丁）
 *
 * 所有广告系列都通过本系统创建，DB 是唯一序号来源。
 * 之前的 Google Ads API 扫描会把同一 MCC 下其他用户 / 其他系统创建的广告系列序号
 * 也计入 max，导致序号暴涨（如 032 → 071）。故已移除 API 扫描。
 *
 * 2026-04-21 补丁：序号计算改为用户全局（跨所有 MCC），不再按 MCC 单独计数。
 * 原按-MCC 计数会导致不同 MCC 各自维护独立序号，用户看到"倒退"命名（如全局
 * 已有 313 条，但新建 mcc=17 的广告系列仍被命名为 306）。锁也改为用户级。
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 校验名称是否符合系统命名格式: 序号-平台-商家名-国家-日期-MID
 *
 * C-088（2026-05-26）放宽：去掉 parts[3] 国家段和 parts[4] 日期段的格式校验。
 * 仅要求 parts.length≥6 且首段为纯数字序号即视为已分配正式名。
 * 这是为了让用户在广告预览页自定义任意命名段（如把日期改为 CZS / 把商家改为别名）
 * 后，重新提交时不被 hasAssignedFormalCampaignName 误判为"未分配"而触发重新分配序号。
 */
function isSystemCampaignName(parts: string[]): boolean {
  if (parts.length < 6) return false;
  if (!/^\d+$/.test(parts[0])) return false;
  return true;
}

export function hasAssignedFormalCampaignName(name: string | null | undefined): boolean {
  if (!name || name.startsWith("DRAFT-")) return false;
  const parts = name.split("-");
  return isSystemCampaignName(parts);
}

/**
 * 从广告系列名称中提取序号（仅识别系统命名格式）
 */
function extractSeqFromName(name: string, namingRule: string, platformLabel?: string): number {
  if (!name) return 0;
  const parts = name.split("-");
  if (!isSystemCampaignName(parts)) return 0;

  if (namingRule === "per_platform") {
    if (platformLabel && parts[1]?.trim().toUpperCase() !== platformLabel.toUpperCase()) return 0;
  }

  return parseInt(parts[0], 10);
}

/**
 * 仅「已提交 Google 且未删除」的广告系列参与三位序号统计与占号（草稿、已删不占号）
 * 序号跨用户下所有 MCC 全局计算，避免不同 MCC 各自计数导致序号"倒退"。
 */
export function campaignFormalSequenceWhere(userId: bigint, _mccId?: bigint | null): Record<string, unknown> {
  return {
    user_id: userId,
    is_deleted: 0,
    google_campaign_id: { not: null },
  };
}

/** 锁粒度：用户级（跨 MCC），确保同一用户并发提交时序号全局唯一 */
function lockKeyForCampaignSeq(userId: bigint, _mccId?: bigint | null): string {
  return `campseq_${userId}`;
}

function escapeMySqlString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

async function acquireCampaignSeqLock(tx: TxClient, userId: bigint, mccId?: bigint | null): Promise<void> {
  const key = escapeMySqlString(lockKeyForCampaignSeq(userId, mccId));
  const rows = await tx.$queryRawUnsafe<Array<{ v: number | bigint | null }>>(`SELECT GET_LOCK('${key}', 15) AS v`);
  const v = rows?.[0]?.v;
  const ok = v === 1 || v === BigInt(1);
  if (!ok) {
    throw new Error("获取广告系列命名锁失败，请稍后重试");
  }
}

async function releaseCampaignSeqLock(tx: TxClient, userId: bigint, mccId?: bigint | null): Promise<void> {
  const key = escapeMySqlString(lockKeyForCampaignSeq(userId, mccId));
  await tx.$queryRawUnsafe(`SELECT RELEASE_LOCK('${key}')`);
}

function computeDbMaxSeqFromTx(
  rows: { campaign_name: string | null }[],
  namingRule: string,
  platformLabel: string,
): number {
  let max = 0;
  let maxName = "";
  for (const c of rows) {
    const num = extractSeqFromName(c.campaign_name || "", namingRule, platformLabel);
    if (num > max) {
      max = num;
      maxName = c.campaign_name || "";
    }
  }
  if (max > 0) {
    console.log(`[CampaignNaming] DB maxSeq=${max} from "${maxName}" (total ${rows.length} formal campaigns)`);
  }
  return max;
}

/** 任意未删除行占用此前缀即视为冲突（含历史遗留的 NNN- 草稿，避免与新建正式名撞号）
 *  冲突检测跨用户所有 MCC，确保序号全局唯一。
 */
async function seqPrefixTakenInTx(
  tx: TxClient,
  userId: bigint,
  _mccId: bigint | null | undefined,
  seq: number,
  excludeCampaignId?: bigint,
): Promise<boolean> {
  const prefix = `${String(seq).padStart(3, "0")}-`;
  const where: Record<string, unknown> = {
    user_id: userId,
    is_deleted: 0,
    campaign_name: { startsWith: prefix },
  };
  if (excludeCampaignId) {
    where.id = { not: excludeCampaignId };
  }
  const row = await tx.campaigns.findFirst({
    where: where as never,
    select: { id: true },
  });
  return !!row;
}

/**
 * 认领商家时占位名：不参与系统序号（首段非纯数字），提交 Google 时再分配正式 NNN-
 */
export function buildDraftCampaignName(userId: bigint, userMerchantId: bigint): string {
  return `DRAFT-u${userId}-m${userMerchantId}-${Date.now()}`;
}

export function campaignNameCleanAndMmdd(merchantName: string): { cleanName: string; mmdd: string } {
  const now = new Date();
  const mmdd = `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const cleanName = merchantName
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff ]/g, "")
    .trim()
    .replace(/\s+/g, "")
    .slice(0, 30);
  return { cleanName, mmdd };
}

/**
 * 根据用户在同一平台下的多个账号连接，解析带账号编号的平台标签（如 PM1, RW2）
 * D-168：编号 = platform_connections.account_index（07 规则的持久化位次：占位、删号补缺），
 * 与「系列名平台段序号 → 联盟账号」的归属解析（backfillCampaignConnections）同一套口径。
 * 旧实现按连接 id 顺序数位置，删号后位次前移，会生成与位次不符的序号（wj04 PM 批量 PM1 的根因）。
 */
export async function resolvePlatformLabel(
  userId: bigint,
  platform: string,
  platformConnectionId: bigint | null | undefined,
): Promise<string> {
  if (!platform) return "";
  if (!platformConnectionId) return `${platform}1`;

  const conn = await prisma.platform_connections.findFirst({
    where: { id: platformConnectionId, user_id: userId, is_deleted: 0 },
    select: { id: true, account_index: true },
  });
  if (conn?.account_index) return `${platform}${conn.account_index}`;

  // account_index 未回填的兜底：按创建顺序数位置（与迁移回填口径一致）
  const connections = await prisma.platform_connections.findMany({
    where: { user_id: userId, platform, is_deleted: 0 },
    select: { id: true },
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
  });
  const index = connections.findIndex(c => c.id === platformConnectionId);
  return `${platform}${index >= 0 ? index + 1 : 1}`;
}

/* fetchGoogleAdsMaxCampaignSequence 已移除 — 见文件头部说明 */

export type NextCampaignNameTxArgs = {
  userId: bigint;
  mccId: bigint | null | undefined;
  namingRule: string;
  platformLabel: string;
  cleanName: string;
  country: string;
  mmdd: string;
  merchantId: string;
  /** 重命名本行时，前缀冲突检测排除自身 */
  excludeCampaignId?: bigint;
};

/**
 * 在已持有命名锁的事务内，计算下一个不重名的正式广告系列名称（仅基于 DB 序号）
 */
export async function resolveNextCampaignNameInTx(tx: TxClient, args: NextCampaignNameTxArgs): Promise<string> {
  const { userId, mccId, namingRule, platformLabel, cleanName, country, mmdd, merchantId, excludeCampaignId } = args;

  const existingCampaigns = await tx.campaigns.findMany({
    where: campaignFormalSequenceWhere(userId, mccId) as never,
    select: { campaign_name: true },
  });

  const dbMaxSeq = computeDbMaxSeqFromTx(existingCampaigns, namingRule, platformLabel);
  let seq = dbMaxSeq + 1;

  let guard = 0;
  while (await seqPrefixTakenInTx(tx, userId, mccId, seq, excludeCampaignId)) {
    seq += 1;
    if (++guard > 5000) {
      throw new Error("广告系列序号分配失败：冲突过多，请联系管理员");
    }
  }

  const seqStr = String(seq).padStart(3, "0");
  console.log(`[CampaignNaming] dbMax=${dbMaxSeq} → seq=${seqStr} (user=${userId}, mcc=${mccId})`);
  return `${seqStr}-${platformLabel}-${cleanName}-${country}-${mmdd}-${merchantId}`;
}

export async function acquireCampaignSeqLockInTx(tx: TxClient, userId: bigint, mccId?: bigint | null): Promise<void> {
  await acquireCampaignSeqLock(tx, userId, mccId);
}

export async function releaseCampaignSeqLockInTx(tx: TxClient, userId: bigint, mccId?: bigint | null): Promise<void> {
  await releaseCampaignSeqLock(tx, userId, mccId);
}

/**
 * 生成正式广告系列名称（重新发布等场景，此时本地行可能仍带 google_campaign_id 直至调用方 update）
 */
export async function generateCampaignName(
  userId: bigint,
  platform: string,
  merchantName: string,
  country: string,
  merchantId: string,
  namingRule: string,
  _accountName?: string,
  _namingPrefix?: string,
  mccId?: bigint | null,
  excludeCampaignId?: bigint,
): Promise<string> {
  void _accountName;
  void _namingPrefix;
  const { cleanName, mmdd } = campaignNameCleanAndMmdd(merchantName);
  const platformLabel = platform;

  return prisma.$transaction(async (tx) => {
    await acquireCampaignSeqLock(tx, userId, mccId);
    try {
      return await resolveNextCampaignNameInTx(tx, {
        userId,
        mccId,
        namingRule,
        platformLabel,
        cleanName,
        country,
        mmdd,
        merchantId,
        excludeCampaignId,
      });
    } finally {
      await releaseCampaignSeqLock(tx, userId, mccId);
    }
  }, { timeout: 25000 });
}

/**
 * 首次提交 Google 前：分配正式名称并写回 campaigns 行（持锁事务）
 */
export async function assignFormalCampaignNameBeforeSubmit(params: {
  campaignId: bigint;
  userId: bigint;
  mccId: bigint | null;
  namingRule: string;
  platformLabel: string;
  country: string;
  merchantName: string;
  merchantId: string;
}): Promise<string> {
  const { campaignId, userId, mccId, namingRule, platformLabel, country, merchantName, merchantId } = params;

  const existing = await prisma.campaigns.findFirst({
    where: { id: campaignId, user_id: userId, is_deleted: 0 },
    select: { campaign_name: true },
  });
  if (existing?.campaign_name && hasAssignedFormalCampaignName(existing.campaign_name)) {
    return existing.campaign_name;
  }

  const { cleanName, mmdd } = campaignNameCleanAndMmdd(merchantName);

  return prisma.$transaction(async (tx) => {
    await acquireCampaignSeqLock(tx, userId, mccId);
    try {
      const name = await resolveNextCampaignNameInTx(tx, {
        userId,
        mccId,
        namingRule,
        platformLabel,
        cleanName,
        country,
        mmdd,
        merchantId,
        excludeCampaignId: campaignId,
      });
      await tx.campaigns.update({
        where: { id: campaignId },
        data: { campaign_name: name },
      });
      return name;
    } finally {
      await releaseCampaignSeqLock(tx, userId, mccId);
    }
  }, { timeout: 25000 });
}
