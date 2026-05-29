/**
 * D-047 / C-113 — 关键词「AI 池内选词」共享模块
 *
 * 07 决策（2026-05-29）：
 *   - 删除前端「关键词确认」第一步闸门
 *   - AI 不再「生成 / 造词」，只在 SemRush 真实的「自然词池 + 付费词池」里「选择」
 *   - 数量由 AI 按预算 / CPC 自行决定（预算小选少、大选多）
 *   - 优先付费词（已验证商业投放价值），自然词补充高相关长尾
 *   - match type 用三因子（预算 + CPC + 竞争度）后端统一决策（沿用 C-112 X4=C）
 *
 * 关键护栏：AI 只能返回候选清单里的编号；后端严格校验所选 phrase 必须存在于池内，
 * 杜绝任何凭空造词（防 ai_generated 复发）。
 */

import { type SemRushKeyword } from "@/lib/semrush-client";
import { isPolicyRiskKeyword } from "@/lib/keyword-optimizer";
import { callAiWithFallback } from "@/lib/ai-service";

export type KeywordMatchType = "EXACT" | "PHRASE" | "BROAD";

export interface SelectedKeyword {
  phrase: string;
  volume: number | null;
  cpc: number | null;
  suggested_bid: number | null;
  competition: string | number | null;
  /** 真实来源：付费投放词 / 自然排名词（不再有 ai_generated） */
  source: "semrush_paid" | "semrush_organic";
  recommended_match_type: KeywordMatchType;
  score: number | null;
  reason: string;
  competition_band: "LOW" | "MEDIUM" | "HIGH" | null;
  intent_layer: "BRAND" | "HIGH_INTENT" | "FEATURE_SCENE";
}

export interface SelectKeywordOptions {
  merchantName: string;
  domain: string;
  /** 日预算（USD 当量） */
  dailyBudgetUsd: number;
  /** 最高 CPC（USD 当量） */
  maxCpcUsd: number;
}

/** SemRush competition（0-1 或字符串）归一化为 0-100 的竞争度，近似关键词难度 KD */
function normalizeCompetition(competition: string | number | null | undefined): number {
  if (competition == null) return 50;
  const n = typeof competition === "number" ? competition : Number(competition);
  if (Number.isNaN(n)) return 50;
  // SemRush 付费 competition 多为 0-1；偶有 0-100
  if (n <= 1) return Math.round(n * 100);
  return Math.min(100, Math.round(n));
}

function competitionBand(kd: number): "LOW" | "MEDIUM" | "HIGH" {
  if (kd < 34) return "LOW";
  if (kd < 67) return "MEDIUM";
  return "HIGH";
}

/** 三因子 match type 决策（沿用 keyword-intelligence 的 X4=C 逻辑，用 competition 近似 KD） */
function decideMatchType(
  kd: number,
  dailyBudgetUsd: number,
  maxCpcUsd: number,
  isBrand: boolean,
): KeywordMatchType {
  // 品牌词永远精准匹配，避免预算被泛词吃掉
  if (isBrand) return "EXACT";
  if (dailyBudgetUsd < 10 || maxCpcUsd > 1.5 || kd > 70) return "EXACT";
  if (dailyBudgetUsd < 30 || kd > 40) return "PHRASE";
  return "BROAD";
}

/** 品牌词识别：phrase 含商家名 token 或域名主体 */
function isBrandKeyword(phrase: string, merchantName: string, domain: string): boolean {
  const p = phrase.toLowerCase();
  const brandTokens = new Set<string>();
  for (const t of merchantName.toLowerCase().split(/\s+/)) {
    if (t.length >= 3) brandTokens.add(t);
  }
  // 域名主体（去 www / TLD），如 drhauschka.com → drhauschka
  const domainCore = domain.toLowerCase().replace(/^www\./, "").split(".")[0];
  if (domainCore && domainCore.length >= 3) brandTokens.add(domainCore);
  return [...brandTokens].some((t) => p.includes(t));
}

/** 预算 → 给 AI 的建议选词数量（AI 可在 ±2 内浮动；后端最终 clamp [3,14]） */
function suggestCount(dailyBudgetUsd: number): number {
  if (dailyBudgetUsd < 5) return 4;
  if (dailyBudgetUsd < 15) return 7;
  return 11;
}

/** 清洗 + 去重一个词池（保留原始 SemRushKeyword） */
function cleanPool(pool: SemRushKeyword[], seen: Set<string>): SemRushKeyword[] {
  const out: SemRushKeyword[] = [];
  for (const kw of pool) {
    const phrase = (kw.phrase || "").trim();
    if (!phrase || phrase.length < 2 || phrase.length > 80) continue;
    if (isPolicyRiskKeyword(phrase)) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...kw, phrase });
  }
  return out;
}

interface Candidate {
  id: string;
  kw: SemRushKeyword;
  source: "semrush_paid" | "semrush_organic";
}

/** 把候选组装成最终 SelectedKeyword（含三因子 match type） */
function toSelected(
  c: Candidate,
  opts: SelectKeywordOptions,
): SelectedKeyword {
  const kd = normalizeCompetition(c.kw.competition);
  const isBrand = isBrandKeyword(c.kw.phrase, opts.merchantName, opts.domain);
  const matchType = decideMatchType(kd, opts.dailyBudgetUsd, opts.maxCpcUsd, isBrand);
  const isPaid = c.source === "semrush_paid";
  const reason = isPaid
    ? `AI 优选 · SEMrush 付费投放词（月搜索量 ${c.kw.volume ?? 0}${c.kw.trafficPercent != null ? `，流量占比 ${(c.kw.trafficPercent).toFixed(1)}%` : ""}）`
    : `AI 优选 · SEMrush 自然排名词（月搜索量 ${c.kw.volume ?? 0}）`;
  return {
    phrase: c.kw.phrase,
    volume: c.kw.volume ?? null,
    cpc: c.kw.cpc ?? null,
    suggested_bid: c.kw.suggested_bid ?? null,
    competition: c.kw.competition ?? null,
    source: c.source,
    recommended_match_type: matchType,
    score: null,
    reason,
    competition_band: competitionBand(kd),
    intent_layer: isBrand ? "BRAND" : isPaid ? "HIGH_INTENT" : "FEATURE_SCENE",
  };
}

/** 兜底选词（AI 不可用时）：付费优先 + 自然补足，绝不造词 */
function fallbackSelect(
  paidCands: Candidate[],
  organicCands: Candidate[],
  target: number,
  opts: SelectKeywordOptions,
): SelectedKeyword[] {
  const picked: Candidate[] = [];
  // 付费词全要（最多 target 的 2/3），剩余给自然词
  const paidQuota = Math.max(1, Math.ceil(target * 0.6));
  picked.push(...paidCands.slice(0, paidQuota));
  const remain = target - picked.length;
  if (remain > 0) picked.push(...organicCands.slice(0, remain));
  // 若付费不足、自然也补不满，再用剩余付费填
  if (picked.length < target) {
    picked.push(...paidCands.slice(paidQuota));
  }
  return picked.slice(0, target).map((c) => toSelected(c, opts));
}

/**
 * AI 从「自然词池 + 付费词池」里选词（只选不造）。
 * @returns 最终关键词列表（付费优先排序），失败时走兜底（仍只选不造）。
 */
export async function selectKeywordsWithAi(
  organicPool: SemRushKeyword[],
  paidPool: SemRushKeyword[],
  opts: SelectKeywordOptions,
): Promise<SelectedKeyword[]> {
  const seen = new Set<string>();
  // 付费池先清洗（优先级高，先占 seen），再清洗自然池（去掉与付费重复的）
  const paidClean = cleanPool(paidPool, seen)
    .sort((a, b) => (b.trafficPercent ?? 0) * (b.volume ?? 0) - (a.trafficPercent ?? 0) * (a.volume ?? 0));
  const organicClean = cleanPool(organicPool, seen)
    .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));

  // 候选规模限制：付费最多 15，自然 top 30（给 AI 的可选范围）
  const paidCands: Candidate[] = paidClean.slice(0, 15).map((kw, i) => ({
    id: `P${i + 1}`,
    kw,
    source: "semrush_paid",
  }));
  const organicCands: Candidate[] = organicClean.slice(0, 30).map((kw, i) => ({
    id: `O${i + 1}`,
    kw,
    source: "semrush_organic",
  }));
  const candMap = new Map<string, Candidate>();
  for (const c of [...paidCands, ...organicCands]) candMap.set(c.id, c);

  const target = suggestCount(opts.dailyBudgetUsd);

  // 没有任何真实候选 → 返回空（前端走"手动输入"）
  if (candMap.size === 0) return [];

  // 候选不多时直接兜底，省一次 AI 调用
  if (candMap.size <= 3) {
    return fallbackSelect(paidCands, organicCands, Math.min(target, candMap.size), opts);
  }

  const fmt = (c: Candidate) => {
    const k = c.kw;
    const parts = [`vol=${k.volume ?? 0}`];
    if (k.cpc != null) parts.push(`cpc=$${k.cpc}`);
    if (k.competition != null) parts.push(`comp=${k.competition}`);
    return `[${c.id}] "${k.phrase}" (${parts.join(", ")})`;
  };
  const paidList = paidCands.map(fmt).join("\n") || "(none)";
  const organicList = organicCands.map(fmt).join("\n") || "(none)";

  const prompt = `You are a Google Ads keyword strategist. Select the BEST keywords for this merchant by CHOOSING from the candidate lists below. You MUST NOT invent any new keyword — only pick from the provided IDs.

Merchant: ${opts.merchantName || opts.domain}
Website: ${opts.domain}
Daily budget: $${opts.dailyBudgetUsd.toFixed(2)}
Max CPC: $${opts.maxCpcUsd.toFixed(2)}

PAID keywords (proven commercial value — prefer these first):
${paidList}

ORGANIC keywords (use to add highly-relevant long-tail coverage):
${organicList}

Rules:
- Pick ONLY ids that appear above. Never output an id that is not listed. Never write a keyword text that is not in the lists.
- Prioritize PAID keywords first (they already proved commercial intent); then fill with the most relevant ORGANIC long-tail terms.
- Drop any keyword clearly unrelated to the merchant's actual products/services.
- Choose the NUMBER of keywords based on budget: small budget → fewer (around ${Math.max(3, target - 2)}), larger budget → more (around ${target + 2}). Aim for about ${target}, range 3 to 14.
- Return ONLY valid JSON, no commentary:
{"selected":["P1","O3", ...]}`;

  try {
    const raw = await callAiWithFallback(
      "ad_creation_intelligent",
      [{ role: "user", content: prompt }],
      400,
    );
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI 未返回 JSON");
    const parsed = JSON.parse(match[0]) as { selected?: unknown };
    const ids = Array.isArray(parsed.selected) ? parsed.selected : [];
    const seenId = new Set<string>();
    const picked: Candidate[] = [];
    for (const idRaw of ids) {
      const id = String(idRaw || "").trim().toUpperCase();
      if (seenId.has(id)) continue;
      const c = candMap.get(id);
      if (!c) continue; // 护栏：AI 编造的 id 直接丢弃
      seenId.add(id);
      picked.push(c);
    }
    if (picked.length === 0) {
      console.warn("[KeywordSelector] AI 选词为空或全部无效，走兜底");
      return fallbackSelect(paidCands, organicCands, target, opts);
    }
    // 付费优先排序 + clamp 数量
    picked.sort((a, b) => {
      if (a.source !== b.source) return a.source === "semrush_paid" ? -1 : 1;
      return 0;
    });
    const clamped = picked.slice(0, 14);
    console.log(
      `[KeywordSelector] AI 选词成功 picked=${clamped.length}/${candMap.size} (paid=${clamped.filter((c) => c.source === "semrush_paid").length} organic=${clamped.filter((c) => c.source === "semrush_organic").length}) budget=$${opts.dailyBudgetUsd}`,
    );
    return clamped.map((c) => toSelected(c, opts));
  } catch (err) {
    console.warn(
      "[KeywordSelector] AI 选词失败，走兜底（仍只选不造）:",
      err instanceof Error ? err.message : String(err),
    );
    return fallbackSelect(paidCands, organicCands, target, opts);
  }
}
