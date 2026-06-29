/**
 * 广告系列防重创建 —— 统一口径 user_id + google_campaign_id（与 MCC 解耦）
 *
 * 背景：campaigns 表历史上同一 gcid 出现多副本，根因是各同步路径查重口径不一致
 * （旧实现按 user+mcc+gcid 查，客户在 MCC 间迁移后查不到旧行就新建）、缺 DB 唯一约束、缺"防回灌"。
 *
 * gcid 在 Google 全局唯一，客户可在 MCC 间迁移但 gcid 不变；因此本系统对一个 user 的同一 gcid
 * 只应有一行。本 helper 统一按 (user_id, google_campaign_id) 查重：
 *   1. 已有活跃行（任意 mcc）→ 把 mcc_id/customer_id 指向当前同步上下文（处理客户迁 MCC），返回该行，绝不新建。
 *   2. 防回灌：无活跃行但有软删行（被刻意清洗）→ 跳过，返回 null。
 *   3. 完全不存在 → 创建；命中唯一约束(P2002) → 取已存在活跃行返回（并发兜底）。
 *
 * 注意：所有同步路径都已只加载 is_deleted=0 的 MCC，故步骤①回填的 mcc_id 一定是活跃账户。
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
  // 1) 已有活跃行（跨 mcc，按 user+gcid 查）→ 指向当前 mcc/customer，返回，绝不新建
  const active = await prisma.campaigns.findFirst({
    where: { user_id: ctx.userId, google_campaign_id: ctx.gcid, is_deleted: 0 },
    orderBy: { id: "asc" }, // 多行历史脏数据时取最早一条，与清理保留口径一致
  });
  if (active) {
    const nextMcc = (data as { mcc_id?: bigint | null }).mcc_id ?? null;
    const nextCustomer = (data as { customer_id?: string | null }).customer_id ?? null;
    const patch: { mcc_id?: bigint | null; customer_id?: string } = {};
    if (nextMcc != null && active.mcc_id !== nextMcc) patch.mcc_id = nextMcc; // 客户迁 MCC：把行指到当前活跃账户
    if (nextCustomer && active.customer_id !== nextCustomer) patch.customer_id = nextCustomer;
    if (Object.keys(patch).length > 0) {
      return await prisma.campaigns.update({ where: { id: active.id }, data: patch });
    }
    return active;
  }

  // 2) 防回灌：无活跃行但有软删行（被刻意清洗）→ 跳过
  const deleted = await prisma.campaigns.findFirst({
    where: { user_id: ctx.userId, google_campaign_id: ctx.gcid, is_deleted: 1 },
    select: { id: true },
  });
  if (deleted) return null;

  // 3) 真正不存在 → 创建；P2002（唯一约束/并发）→ 取已存在活跃行返回
  try {
    return await prisma.campaigns.create({ data });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") {
      return await prisma.campaigns.findFirst({
        where: { user_id: ctx.userId, google_campaign_id: ctx.gcid, is_deleted: 0 },
        orderBy: { id: "asc" },
      });
    }
    throw e;
  }
}
