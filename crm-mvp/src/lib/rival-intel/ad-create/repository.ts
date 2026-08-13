/**
 * 竞品情报引擎的草稿 DB 访问层。
 *
 * D-233 移植改动：
 *   - model 名 camelCase（adCreationDraft…）→ CRM 的 snake_case 表名
 *   - team_id + created_by_user_id → 单一 user_id
 *   - Boolean 软删 / manual_cpc → MariaDB TinyInt，写 0/1
 *   - 新增 user_merchant_id：CRM 动线是「商家列表点新增广告」，域名与联盟链接
 *     从商家自动带入，草稿要记住来源商家，发布成功后好回写 campaigns 的归属
 *   - MCC 相关查询改走 CRM 的 google_mcc_accounts（按 user_id，无 team 维度），
 *     kyads 的 mcc_ad_sources 绑定表与 mcc-access 权限计算不移植
 */
import { prisma } from "@/lib/prisma";
import { selectRecentDistinctDomainDrafts } from "./draft-list";
import { DRAFT_STAGES } from "./types";

export async function createDraft(input: {
  userId: bigint;
  userMerchantId?: bigint | null;
  /** 领取商家时已建好的 campaigns.id；发布走 CRM submit 流水线必须有它 */
  campaignId?: bigint | null;
  domain: string;
  countryCode: string;
  /** 显式指定的文案语言；留空表示跟随国家推导。 */
  languageCode?: string | null;
  generationMode: "filter" | "ai_generate";
  landingPageUrl?: string | null;
  defaultCampaignName?: string | null;
}) {
  return prisma.ad_creation_drafts.create({
    data: {
      user_id: input.userId,
      user_merchant_id: input.userMerchantId ?? null,
      campaign_id: input.campaignId ?? null,
      domain: input.domain,
      country_code: input.countryCode,
      language_code: input.languageCode ?? null,
      status: "draft_generating",
      current_stage: DRAFT_STAGES[0],
      completed_stages: [],
      generation_mode: input.generationMode,
      landing_page_url: input.landingPageUrl ?? null,
      default_campaign_name: input.defaultCampaignName ?? null,
    },
  });
}

export async function getDraftById(id: bigint) {
  return prisma.ad_creation_drafts.findFirst({
    where: { id, is_deleted: 0 },
  });
}

/**
 * 列出广告生成草稿。
 *
 * 默认全公司可见（同品牌评估结果的口径）：付费拉回来的竞品数据谁都能看到，
 * 免得两个人对同一域名各买一遍。传 `scopeToUser=true` 时才只看自己的。
 */
export async function listDrafts(input: {
  userId?: bigint;
  scopeToUser?: boolean;
  status?: string;
  page: number;
  pageSize: number;
}) {
  const where = {
    is_deleted: 0,
    ...(input.scopeToUser && input.userId ? { user_id: input.userId } : {}),
    ...(input.status ? { status: input.status } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.ad_creation_drafts.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
    }),
    prisma.ad_creation_drafts.count({ where }),
  ]);

  return { items, total };
}

export async function listRecentDistinctDomainDrafts(input: {
  userId?: bigint;
  scopeToUser?: boolean;
  status?: string;
  limit: number;
}) {
  const where = {
    is_deleted: 0,
    ...(input.scopeToUser && input.userId ? { user_id: input.userId } : {}),
    ...(input.status ? { status: input.status } : {}),
  };

  const batchSize = Math.max(input.limit * 5, 50);
  let skip = 0;
  let selected: Awaited<ReturnType<typeof prisma.ad_creation_drafts.findMany>> = [];

  while (selected.length < input.limit) {
    const batch = await prisma.ad_creation_drafts.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip,
      take: batchSize,
    });

    if (batch.length === 0) break;

    selected = selectRecentDistinctDomainDrafts([...selected, ...batch], input.limit);
    skip += batch.length;
  }

  return { items: selected, total: selected.length };
}

export async function updateDraft(id: bigint, data: Record<string, unknown>) {
  return prisma.ad_creation_drafts.update({
    where: { id },
    data: data as Parameters<typeof prisma.ad_creation_drafts.update>[0]["data"],
  });
}

// 发布任务的 CRUD 不在这里：竞品引擎发布走 CRM 的 submit 流水线，任务行落在
// `ad_submit_jobs`（见 publish-draft.ts 顶部注释）。kyads 的 ad_creation_publish_jobs
// 表与配套的 createPublishJob / updatePublishJob 一并去掉，不留无人写入的空表。

/**
 * 员工可用的 MCC。CRM 的 google_mcc_accounts 直接挂 user_id（没有 team 层），
 * 所以不需要 kyads 那套 admin/绑定表的权限计算。
 */
export async function getUserMccAccounts(userId: bigint) {
  return prisma.google_mcc_accounts.findMany({
    where: { user_id: userId, is_active: 1, is_deleted: 0 },
  });
}

export async function getMccCidAccounts(mccAccountId: bigint) {
  return prisma.mcc_cid_accounts.findMany({
    where: {
      mcc_account_id: mccAccountId,
      is_deleted: 0,
      status: "active",
      is_available: { not: "D" },
    },
  });
}
