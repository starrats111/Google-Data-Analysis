/**
 * 商家政策审核服务
 * 在商家同步时自动检测商家是否属于 Google Ads 受限/禁止类别
 */
import { PrismaClient } from "@/generated/prisma/client";

interface MerchantInput {
  merchant_name: string;
  merchant_url?: string | null;
  category?: string | null;
  platform: string;
}

interface ReviewResult {
  policy_status: "clean" | "restricted" | "prohibited";
  policy_category_code: string | null;
  policy_category_id: bigint | null;
  matched_rule: string | null;
  restriction_level: string | null;
}

// 缓存政策类别（避免每次同步都查库）
let cachedCategories: any[] | null = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟

async function getPolicyCategories(prisma: PrismaClient) {
  if (cachedCategories && Date.now() - cacheTime < CACHE_TTL) {
    return cachedCategories;
  }
  cachedCategories = await prisma.ad_policy_categories.findMany({
    where: { is_deleted: 0 },
    orderBy: { sort_order: "asc" },
  });
  cacheTime = Date.now();
  return cachedCategories;
}

/** 清除缓存（管理员修改政策类别后调用） */
export function clearPolicyCategoryCache() {
  cachedCategories = null;
  cacheTime = 0;
}

/** 从 URL 提取域名 */
function extractDomain(url: string): string {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url.toLowerCase().replace(/^www\./, "");
  }
}

/**
 * 审核单个商家的政策合规性
 */
export async function reviewMerchantPolicy(
  prisma: PrismaClient,
  merchant: MerchantInput
): Promise<ReviewResult> {
  const categories = await getPolicyCategories(prisma);
  const domain = merchant.merchant_url ? extractDomain(merchant.merchant_url) : "";

  // 拼接搜索文本（全小写）
  const searchText = [
    merchant.merchant_name,
    domain,
    merchant.category || "",
  ].join(" ").toLowerCase();

  for (const cat of categories!) {
    // 1. 精确域名匹配（优先级最高）
    const rawDomains = cat.match_domains;
    const matchDomains: string[] = typeof rawDomains === "string" ? JSON.parse(rawDomains) : (rawDomains as string[] || []);
    for (const d of matchDomains) {
      if (domain && domain.includes(d.toLowerCase())) {
        return {
          policy_status: cat.restriction_level as "restricted" | "prohibited",
          policy_category_code: cat.category_code,
          policy_category_id: cat.id,
          matched_rule: `domain:${d}`,
          restriction_level: cat.restriction_level,
        };
      }
    }

    // 2. 关键词匹配
    const rawKeywords = cat.match_keywords;
    const matchKeywords: string[] = typeof rawKeywords === "string" ? JSON.parse(rawKeywords) : (rawKeywords as string[] || []);
    for (const kw of matchKeywords) {
      if (searchText.includes(kw.toLowerCase())) {
        return {
          policy_status: cat.restriction_level as "restricted" | "prohibited",
          policy_category_code: cat.category_code,
          policy_category_id: cat.id,
          matched_rule: `keyword:${kw}`,
          restriction_level: cat.restriction_level,
        };
      }
    }
  }

  // 未匹配到任何限制类别
  return {
    policy_status: "clean",
    policy_category_code: null,
    policy_category_id: null,
    matched_rule: null,
    restriction_level: null,
  };
}

/**
 * 批量审核商家并写入数据库
 * 用于商家同步时调用
 */
export async function batchReviewMerchants(
  prisma: PrismaClient,
  merchants: Array<{
    id: bigint;
    merchant_name: string;
    merchant_url?: string | null;
    category?: string | null;
    platform: string;
  }>
): Promise<{ reviewed: number; restricted: number; prohibited: number }> {
  let reviewed = 0, restricted = 0, prohibited = 0;

  // 先审核所有商家，收集结果
  const cleanIds: bigint[] = [];
  const taggedMerchants: Array<{
    id: bigint;
    merchant_name: string;
    merchant_url?: string | null;
    platform: string;
    result: ReviewResult;
  }> = [];

  for (const m of merchants) {
    const result = await reviewMerchantPolicy(prisma, m);
    reviewed++;

    if (result.policy_status === "clean") {
      cleanIds.push(m.id);
    } else {
      taggedMerchants.push({ ...m, result });
      if (result.policy_status === "restricted") restricted++;
      if (result.policy_status === "prohibited") prohibited++;
    }
  }

  // 批量更新 clean 商家（一条 SQL）
  if (cleanIds.length > 0) {
    // 分批处理，每批 500 个，避免 SQL 过长
    for (let i = 0; i < cleanIds.length; i += 500) {
      const batch = cleanIds.slice(i, i + 500);
      await prisma.user_merchants.updateMany({
        where: { id: { in: batch } },
        data: { policy_status: "clean" },
      });
    }
  }

  // 逐条更新有标签的商家（数量少，逐条更新可接受）
  for (const m of taggedMerchants) {
    await prisma.user_merchants.update({
      where: { id: m.id },
      data: {
        policy_status: m.result.policy_status,
        policy_category_code: m.result.policy_category_code,
      },
    });

    // 写入/更新审核记录（用 findFirst + create/update 代替 upsert，避免复合唯一键问题）
    const existing = await prisma.merchant_policy_reviews.findFirst({
      where: {
        merchant_name: m.merchant_name,
        platform: m.platform || null,
        is_deleted: 0,
      },
    });

    if (existing) {
      await prisma.merchant_policy_reviews.update({
        where: { id: existing.id },
        data: {
          merchant_domain: m.merchant_url ? extractDomain(m.merchant_url) : null,
          policy_category_id: m.result.policy_category_id,
          policy_status: m.result.policy_status,
          matched_rule: m.result.matched_rule,
          reviewed_at: new Date(),
        },
      });
    } else {
      await prisma.merchant_policy_reviews.create({
        data: {
          merchant_name: m.merchant_name,
          merchant_domain: m.merchant_url ? extractDomain(m.merchant_url) : null,
          platform: m.platform || null,
          policy_category_id: m.result.policy_category_id,
          policy_status: m.result.policy_status,
          matched_rule: m.result.matched_rule,
          review_method: "auto",
        },
      });
    }
  }

  return { reviewed, restricted, prohibited };
}
