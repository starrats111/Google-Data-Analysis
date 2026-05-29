/**
 * 广告系列防重创建 —— 统一口径 user_id + mcc_id + google_campaign_id（D-048 步骤④）
 *
 * 背景（设计方案 §77.23）：campaigns 表历史上同一 gcid 出现多副本，根因是各同步路径
 * 查重口径不一致、缺 DB 唯一约束、手动同步缺"防回灌"。本 helper 集中两件事：
 *   1. 防回灌：该 (user,mcc) 下该 gcid 已被清洗（仅存软删行、无活跃行）→ 跳过，不再 INSERT。
 *   2. 幂等兜底：命中 DB 唯一约束(P2002) → 取已存在活跃行返回，避免同步因约束冲突报错。
 *
 * 仅在调用方内存 campaignMap 未命中（即将 create）时调用。
 */
import prisma from "@/lib/prisma";

type CampaignRow = NonNullable<Awaited<ReturnType<typeof prisma.campaigns.findFirst>>>;
type CampaignCreateData = Parameters<typeof prisma.campaigns.create>[0]["data"];

interface DedupCtx {
  userId: bigint;
  mccId: bigint;
  gcid: string;
  /** 预加载的"仅软删无活跃"gcid 集合（建议传入以避免 N+1）；不传则回退到逐条 findFirst。 */
  softDeletedGcids?: Set<string>;
}

/**
 * 加载某 (user,mcc) 下"仅有软删行、无活跃行"的 gcid 集合，用于防回灌。
 * 调用方在循环外加载一次，传给 createCampaignDedup。
 */
export async function loadSoftDeletedGcids(userId: bigint, mccId: bigint): Promise<Set<string>> {
  const rows = await prisma.campaigns.findMany({
    where: { user_id: userId, mcc_id: mccId, google_campaign_id: { not: null } },
    select: { google_campaign_id: true, is_deleted: true },
  });
  const active = new Set<string>();
  const deleted = new Set<string>();
  for (const r of rows) {
    const g = r.google_campaign_id;
    if (!g) continue;
    if (r.is_deleted === 0) active.add(g);
    else deleted.add(g);
  }
  const onlyDeleted = new Set<string>();
  for (const g of deleted) if (!active.has(g)) onlyDeleted.add(g);
  return onlyDeleted;
}

/**
 * 防重创建广告系列。命中防回灌返回 null（调用方应跳过该 gcid 的后续写入）。
 */
export async function createCampaignDedup(
  data: CampaignCreateData,
  ctx: DedupCtx,
): Promise<CampaignRow | null> {
  // 1) 防回灌
  if (ctx.softDeletedGcids) {
    if (ctx.softDeletedGcids.has(ctx.gcid)) return null;
  } else {
    const active = await prisma.campaigns.findFirst({
      where: { user_id: ctx.userId, mcc_id: ctx.mccId, google_campaign_id: ctx.gcid, is_deleted: 0 },
      select: { id: true },
    });
    if (!active) {
      const deleted = await prisma.campaigns.findFirst({
        where: { user_id: ctx.userId, mcc_id: ctx.mccId, google_campaign_id: ctx.gcid, is_deleted: 1 },
        select: { id: true },
      });
      if (deleted) return null; // 被清洗过，跳过回灌
    }
  }

  // 2) create + P2002 幂等兜底
  try {
    return await prisma.campaigns.create({ data });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") {
      return await prisma.campaigns.findFirst({
        where: { user_id: ctx.userId, mcc_id: ctx.mccId, google_campaign_id: ctx.gcid, is_deleted: 0 },
        orderBy: { id: "desc" },
      });
    }
    throw e;
  }
}
