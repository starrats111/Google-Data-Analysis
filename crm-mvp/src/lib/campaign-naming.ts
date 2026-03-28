import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

type TxClient = Prisma.TransactionClient;

/**
 * 校验名称是否符合系统命名格式: 序号-平台-商家名-国家(2字母)-日期(MMDD)-MID
 * 至少 6 段，且国家位(parts[3])为 2 位字母、日期位(parts[4])为 4 位数字
 */
function isSystemCampaignName(parts: string[]): boolean {
  if (parts.length < 6) return false;
  if (!/^\d+$/.test(parts[0])) return false;
  if (!/^[A-Z]{2}$/i.test(parts[3])) return false;
  if (!/^\d{4}$/.test(parts[4])) return false;
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
 * MCC 范围：与历史逻辑一致（当前 MCC 或尚未写入 mcc 的行）
 */
function campaignMccScope(userId: bigint, mccId?: bigint | null): Record<string, unknown> {
  const w: Record<string, unknown> = { user_id: userId };
  if (mccId) {
    w.OR = [{ mcc_id: mccId }, { mcc_id: null }];
  }
  return w;
}

/**
 * 仅「已提交 Google 且未删除」的广告系列参与三位序号统计与占号（草稿、已删不占号）
 */
export function campaignFormalSequenceWhere(userId: bigint, mccId?: bigint | null): Record<string, unknown> {
  return {
    ...campaignMccScope(userId, mccId),
    is_deleted: 0,
    google_campaign_id: { not: null },
  };
}

function lockKeyForCampaignSeq(userId: bigint, mccId?: bigint | null): string {
  return `campseq_${userId}_${mccId ?? BigInt(0)}`;
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

/** 任意未删除行占用此前缀即视为冲突（含历史遗留的 NNN- 草稿，避免与新建正式名撞号） */
async function seqPrefixTakenInTx(
  tx: TxClient,
  userId: bigint,
  mccId: bigint | null | undefined,
  seq: number,
  excludeCampaignId?: bigint,
): Promise<boolean> {
  const prefix = `${String(seq).padStart(3, "0")}-`;
  const where: Record<string, unknown> = {
    ...campaignMccScope(userId, mccId),
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

export async function fetchGoogleAdsMaxCampaignSequence(
  _userId: bigint,
  mccId: bigint | null | undefined,
  namingRule: string,
  platformLabel: string,
): Promise<number> {
  void _userId;
  if (!mccId) return 0;
  try {
    const mccAccount = await prisma.google_mcc_accounts.findFirst({
      where: { id: mccId, is_deleted: 0 },
    });
    if (!mccAccount?.service_account_json || !mccAccount?.developer_token) return 0;

    const { queryGoogleAds } = await import("@/lib/google-ads/client");
    const credentials = {
      mcc_id: mccAccount.mcc_id,
      developer_token: mccAccount.developer_token,
      service_account_json: mccAccount.service_account_json,
    };

    const cids = await prisma.mcc_cid_accounts.findMany({
      where: { mcc_account_id: mccId, is_deleted: 0 },
      select: { customer_id: true },
    });

    let googleMaxSeq = 0;
    const cidSlice = cids.slice(0, 10);
    const BATCH = 5;
    const timeoutMs = 8000;
    const deadline = Date.now() + timeoutMs;

    for (let i = 0; i < cidSlice.length; i += BATCH) {
      if (Date.now() >= deadline) {
        console.warn(`[CampaignNaming] Google Ads 查询已超 ${timeoutMs}ms，跳过剩余 CID`);
        break;
      }
      const batch = cidSlice.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async (cid) => {
          const rows = await queryGoogleAds(credentials, cid.customer_id.replace(/-/g, ""), `
                SELECT campaign.name
                FROM campaign
                WHERE campaign.status != 'REMOVED'
              `);
          let batchMax = 0;
          let batchMaxName = "";
          for (const row of rows) {
            const c = row.campaign as Record<string, unknown> | undefined;
            const name = String(c?.name ?? "");
            const num = extractSeqFromName(name, namingRule, platformLabel);
            if (num > batchMax) {
              batchMax = num;
              batchMaxName = name;
            }
          }
          if (batchMax > 0) {
            console.log(`[CampaignNaming] Google Ads CID ${cid.customer_id} maxSeq=${batchMax} from "${batchMaxName}" (${rows.length} campaigns)`);
          }
          return batchMax;
        }),
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value > googleMaxSeq) {
          googleMaxSeq = r.value;
        }
      }
    }
    return googleMaxSeq;
  } catch (err) {
    console.warn("[CampaignNaming] Google Ads 查询失败，仅使用数据库序号:", err instanceof Error ? err.message : err);
    return 0;
  }
}

export type NextCampaignNameTxArgs = {
  userId: bigint;
  mccId: bigint | null | undefined;
  namingRule: string;
  platformLabel: string;
  googleMaxSeq: number;
  cleanName: string;
  country: string;
  mmdd: string;
  merchantId: string;
  /** 重命名本行时，前缀冲突检测排除自身 */
  excludeCampaignId?: bigint;
};

/**
 * 在已持有命名锁的事务内，计算下一个不重名的正式广告系列名称（仅与已提交行冲突检测）
 */
export async function resolveNextCampaignNameInTx(tx: TxClient, args: NextCampaignNameTxArgs): Promise<string> {
  const { userId, mccId, namingRule, platformLabel, googleMaxSeq, cleanName, country, mmdd, merchantId, excludeCampaignId } = args;

  const existingCampaigns = await tx.campaigns.findMany({
    where: campaignFormalSequenceWhere(userId, mccId) as never,
    select: { campaign_name: true },
  });

  const dbMaxSeq = computeDbMaxSeqFromTx(existingCampaigns, namingRule, platformLabel);
  let seq = Math.max(dbMaxSeq, googleMaxSeq) + 1;

  let guard = 0;
  while (await seqPrefixTakenInTx(tx, userId, mccId, seq, excludeCampaignId)) {
    seq += 1;
    if (++guard > 5000) {
      throw new Error("广告系列序号分配失败：冲突过多，请联系管理员");
    }
  }

  const seqStr = String(seq).padStart(3, "0");
  console.log(`[CampaignNaming] Final: dbMax=${dbMaxSeq}, googleMax=${googleMaxSeq} → seq=${seqStr}`);
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
  const googleMaxSeq = await fetchGoogleAdsMaxCampaignSequence(userId, mccId, namingRule, platformLabel);

  return prisma.$transaction(async (tx) => {
    await acquireCampaignSeqLock(tx, userId, mccId);
    try {
      return await resolveNextCampaignNameInTx(tx, {
        userId,
        mccId,
        namingRule,
        platformLabel,
        googleMaxSeq,
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

  const googleMaxSeq = await fetchGoogleAdsMaxCampaignSequence(userId, mccId, namingRule, platformLabel);
  const { cleanName, mmdd } = campaignNameCleanAndMmdd(merchantName);

  return prisma.$transaction(async (tx) => {
    await acquireCampaignSeqLock(tx, userId, mccId);
    try {
      const name = await resolveNextCampaignNameInTx(tx, {
        userId,
        mccId,
        namingRule,
        platformLabel,
        googleMaxSeq,
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
