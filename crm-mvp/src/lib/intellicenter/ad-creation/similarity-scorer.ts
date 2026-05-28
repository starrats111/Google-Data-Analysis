/**
 * C-112 / D-046.C — Step 7：文案-关键词符合度评分
 *
 * 07 决策 X5=B 阈值 = 0.7（Jaccard/token-overlap 相似度，非严格 embedding cosine）
 *
 * 为什么用 token-overlap 不用 embedding：
 *   - embedding 需要额外 API call（成本 + 延迟），gpt-5-nano 不擅长 embedding
 *   - Google Ads 文案 + 关键词都是短文本，token 级 overlap 在实证中与 embedding 高度相关
 *   - 简单可解释 — 员工/admin 看到分数能直观理解
 *
 * 评分逻辑：
 *   - 单条 headline / description 对 keyword 列表算 max Jaccard
 *   - 整组文案的 avgSimilarity = mean(每条对全部关键词的 max Jaccard)
 *   - avgSimilarity < 0.7 → 触发返工（orchestrator 调 Step 6 重新生成）
 *
 * 返工策略：最多 2 轮，每轮把上次的低分原因（哪些关键词没匹配）写到 prompt 让 AI 重写。
 */

import type { KeywordWithMatchType } from "./keyword-intelligence";

const SIMILARITY_THRESHOLD = 0.7; // X5=B
const STOPWORDS = new Set([
  "the", "and", "for", "with", "your", "you", "our", "from",
  "shop", "buy", "now", "online", "official", "site", "store",
  "free", "great", "best", "new", "top", "more", "less",
  "a", "an", "of", "in", "on", "at", "to", "by", "is", "are", "be",
  // 中文常见停用词
  "的", "了", "在", "是", "我", "有", "和", "就", "都", "也",
]);

export interface SimilarityScore {
  /** 该条文案的整体相似度（对所有 keyword 取 max 后平均化处理） */
  bestSimilarity: number;
  /** 最匹配的 keyword */
  bestMatchKeyword: string | null;
  /** 是否通过阈值 */
  passed: boolean;
}

export interface BatchSimilarityResult {
  /** 单条评分（按输入顺序） */
  perItem: SimilarityScore[];
  /** 整组平均分（用于决定是否整体返工） */
  avgSimilarity: number;
  /** 是否通过阈值 */
  passed: boolean;
  /** 低分条目的诊断信息（供返工 prompt 使用） */
  lowScoringItems: Array<{
    index: number;
    text: string;
    bestSimilarity: number;
    suggestedKeyword: string | null;
  }>;
}

/**
 * 计算单条文案 vs 关键词列表的相似度。
 *
 * 返回该条对所有 keyword 的最大 Jaccard，最匹配的 keyword 作为 bestMatch。
 */
export function scoreSingle(
  text: string,
  keywords: KeywordWithMatchType[],
): SimilarityScore {
  if (keywords.length === 0) {
    return { bestSimilarity: 0, bestMatchKeyword: null, passed: false };
  }
  const textTokens = tokenize(text);
  if (textTokens.size === 0) {
    return { bestSimilarity: 0, bestMatchKeyword: null, passed: false };
  }
  let best = 0;
  let bestKw: string | null = null;
  for (const kw of keywords) {
    const kwTokens = tokenize(kw.text);
    if (kwTokens.size === 0) continue;
    // 使用 token coverage（关键词在文案中的覆盖率）+ Jaccard 取大值
    // 因为关键词通常比文案短，Jaccard 偏低；coverage 更能反映"是否目标关键词"
    const coverage = setOverlapRatio(kwTokens, textTokens); // kw 被文案覆盖的比例
    const jaccard = jaccardSimilarity(textTokens, kwTokens);
    const score = Math.max(coverage, jaccard);
    if (score > best) {
      best = score;
      bestKw = kw.text;
    }
  }
  return {
    bestSimilarity: best,
    bestMatchKeyword: bestKw,
    passed: best >= SIMILARITY_THRESHOLD,
  };
}

/**
 * 批量评分 + 整组诊断。
 */
export function scoreBatch(
  texts: string[],
  keywords: KeywordWithMatchType[],
  options?: { threshold?: number },
): BatchSimilarityResult {
  const thr = options?.threshold ?? SIMILARITY_THRESHOLD;
  const perItem = texts.map((t) => scoreSingle(t, keywords));
  const avg = perItem.length > 0
    ? perItem.reduce((s, p) => s + p.bestSimilarity, 0) / perItem.length
    : 0;

  const lowScoringItems = perItem
    .map((p, i) => ({
      index: i,
      text: texts[i],
      bestSimilarity: p.bestSimilarity,
      suggestedKeyword: p.bestMatchKeyword,
    }))
    .filter((it) => it.bestSimilarity < thr);

  return {
    perItem,
    avgSimilarity: avg,
    passed: avg >= thr,
    lowScoringItems,
  };
}

/**
 * 为返工生成针对性提示：列出哪些条得分低 + 建议靠近哪些关键词。
 */
export function buildRetryHintForLowSimilarity(
  result: BatchSimilarityResult,
  keywords: KeywordWithMatchType[],
  threshold = SIMILARITY_THRESHOLD,
): string {
  const lines: string[] = [];
  lines.push(
    `Some previous outputs scored below the similarity threshold ${threshold.toFixed(2)} against our target keywords. Avg = ${result.avgSimilarity.toFixed(2)}.`,
  );
  lines.push(
    `Target keywords (rewrite to include at least one of these or a very close synonym): ${keywords
      .slice(0, 8)
      .map((k) => k.text)
      .join(" | ")}`,
  );
  if (result.lowScoringItems.length > 0) {
    lines.push(`Low-scoring examples to AVOID repeating:`);
    for (const it of result.lowScoringItems.slice(0, 5)) {
      lines.push(`  - "${it.text}" (sim=${it.bestSimilarity.toFixed(2)})`);
    }
  }
  return lines.join("\n");
}

// --- 内部工具 ---

function tokenize(text: string): Set<string> {
  if (!text) return new Set();
  // 普通空格 + 拼音空格 + CJK 不切分（中文按字符级 + 双字 bigram 后续可加）
  const lower = text
    .toLowerCase()
    .replace(/[“”"'`´’]/g, "")
    .replace(/[!?,.;:/\\|()[\]{}+]/g, " ")
    .replace(/[-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!lower) return new Set();
  const tokens = lower
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  return new Set(tokens);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

/**
 * 计算 ratio = |A ∩ B| / |A|（A 被 B 覆盖的比例）。
 * 适合短关键词 vs 长文案：关键词所有 token 都在文案中即 1.0。
 */
function setOverlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / a.size;
}

export { SIMILARITY_THRESHOLD };
