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
 * 解析 match_domains / match_keywords 字段。
 *
 * 历史缺陷：DB 里这两个 longtext 字段是**双重 JSON 编码**
 * （写入时被 Prisma JSON 序列化一次得到字符串 `[...]`，再被外层 JSON 序列化一次得到 `"[...]"`）。
 * 旧实现只 `JSON.parse()` 一次得到的还是字符串，`for...of` 会**遍历字符串字符**
 * （`b`, `e`, `t`, ...），导致几乎所有商家被随便一个字符命中而误判。
 * 此处兜底做两次 parse，保证拿到真正的 string[]。
 */
function parseStringList(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((s) => String(s));
  if (typeof raw !== "string") return [];
  try {
    let v: unknown = JSON.parse(raw);
    if (typeof v === "string") v = JSON.parse(v);
    if (Array.isArray(v)) return v.map((s) => String(s));
  } catch {
    /* ignore */
  }
  return [];
}

/** 正则元字符转义 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 关键词匹配：使用词边界，避免 `loan` 命中 `loandsons.com` 这种误判。
 * 中文关键词无 `\b` 边界概念，退化为子串匹配（兼容现有中文规则）。
 */
function keywordMatches(text: string, kw: string): boolean {
  const k = kw.trim().toLowerCase();
  if (!k) return false;
  // 全为 ASCII 单词字符 → 走词边界正则
  if (/^[\w\s.+-]+$/.test(k)) {
    try {
      return new RegExp(`\\b${escapeRegex(k)}\\b`, "i").test(text);
    } catch {
      return text.includes(k);
    }
  }
  // 含中文/特殊字符 → 子串匹配
  return text.includes(k);
}

/**
 * 域名匹配：精确等值或子域后缀（`domain === d || domain.endsWith('.' + d)`），
 * 避免 `loandsons.com` 被 `loan` 这种短串包含命中。
 */
function domainMatches(domain: string, d: string): boolean {
  const dd = d.trim().toLowerCase();
  if (!dd || !domain) return false;
  return domain === dd || domain.endsWith("." + dd);
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
    // 1. 域名匹配（精确或子域后缀；不再用子串 includes）
    const matchDomains = parseStringList(cat.match_domains);
    for (const d of matchDomains) {
      if (domainMatches(domain, d)) {
        return {
          policy_status: cat.restriction_level as "restricted" | "prohibited",
          policy_category_code: cat.category_code,
          policy_category_id: cat.id,
          matched_rule: `domain:${d}`,
          restriction_level: cat.restriction_level,
        };
      }
    }

    // 2. 关键词匹配（词边界，避免 loan 命中 loandsons）
    const matchKeywords = parseStringList(cat.match_keywords);
    for (const kw of matchKeywords) {
      if (keywordMatches(searchText, kw)) {
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
 * 纯内存匹配 + 批量 DB 写入，避免逐条查库
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
  let restricted = 0, prohibited = 0;

  const categories = await getPolicyCategories(prisma);

  const cleanIds: bigint[] = [];
  const taggedMerchants: Array<{
    id: bigint;
    merchant_name: string;
    merchant_url?: string | null;
    platform: string;
    result: ReviewResult;
  }> = [];

  for (const m of merchants) {
    const domain = m.merchant_url ? extractDomain(m.merchant_url) : "";
    const searchText = [m.merchant_name, domain, m.category || ""].join(" ").toLowerCase();
    let matched = false;

    for (const cat of categories!) {
      const matchDomains = parseStringList(cat.match_domains);
      for (const d of matchDomains) {
        if (domainMatches(domain, d)) {
          taggedMerchants.push({ ...m, result: { policy_status: cat.restriction_level as "restricted" | "prohibited", policy_category_code: cat.category_code, policy_category_id: cat.id, matched_rule: `domain:${d}`, restriction_level: cat.restriction_level } });
          if (cat.restriction_level === "restricted") restricted++;
          if (cat.restriction_level === "prohibited") prohibited++;
          matched = true;
          break;
        }
      }
      if (matched) break;

      const matchKeywords = parseStringList(cat.match_keywords);
      for (const kw of matchKeywords) {
        if (keywordMatches(searchText, kw)) {
          taggedMerchants.push({ ...m, result: { policy_status: cat.restriction_level as "restricted" | "prohibited", policy_category_code: cat.category_code, policy_category_id: cat.id, matched_rule: `keyword:${kw}`, restriction_level: cat.restriction_level } });
          if (cat.restriction_level === "restricted") restricted++;
          if (cat.restriction_level === "prohibited") prohibited++;
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
    if (!matched) cleanIds.push(m.id);
  }

  const BATCH_SIZE = 500;
  if (cleanIds.length > 0) {
    for (let i = 0; i < cleanIds.length; i += BATCH_SIZE) {
      const batch = cleanIds.slice(i, i + BATCH_SIZE);
      await prisma.user_merchants.updateMany({
        where: { id: { in: batch } },
        data: { policy_status: "clean" },
      });
    }
  }

  if (taggedMerchants.length > 0) {
    const byStatus = new Map<string, { ids: bigint[]; code: string | null }>();
    for (const m of taggedMerchants) {
      const key = `${m.result.policy_status}:${m.result.policy_category_code || ""}`;
      const group = byStatus.get(key) || { ids: [], code: m.result.policy_category_code };
      group.ids.push(m.id);
      byStatus.set(key, group);
    }
    for (const [key, group] of byStatus) {
      const [status] = key.split(":");
      for (let i = 0; i < group.ids.length; i += BATCH_SIZE) {
        const batch = group.ids.slice(i, i + BATCH_SIZE);
        await prisma.user_merchants.updateMany({
          where: { id: { in: batch } },
          data: { policy_status: status, policy_category_code: group.code },
        });
      }
    }
  }

  return { reviewed: merchants.length, restricted, prohibited };
}
