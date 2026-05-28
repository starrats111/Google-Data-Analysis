/**
 * C-112 / D-046.C — Step 5：关键词智能引擎
 *
 * 07 决策 X4=C 三因子 match type 决策（预算 + CPC + 关键词竞争度 SemRush kd）。
 *
 * 5 源融合（按 D-046 R3=A 拍板）：
 *   1) SemRush 主源（最热 + kd 数据）
 *   2) 商家网站爬虫 keywords（pageText / features 提取）
 *   3) 历史成功广告关键词（M11 留空，MVP 暂用 keywords 表中 cost > 0 的）
 *   4) 行业基准（基于画像 industry_category 的通用词）
 *   5) AI 推断兜底
 *
 * Match type 智能选择：
 *   - daily_budget < $10 || max_cpc > $1.5 || kd > 70 → exact only（节约预算）
 *   - daily_budget [$10, $30) || kd [40, 70] → phrase + exact
 *   - daily_budget >= $30 && kd < 40 → broad + theme + phrase + exact（覆盖广）
 */

import type { MerchantIntelligenceProfile, IndustryCategory } from "@/lib/intellicenter/merchant-profile/types";

export interface KeywordCandidate {
  text: string;
  /** SemRush 月搜索量（如果有） */
  searchVolume?: number;
  /** SemRush 关键词难度 0-100 */
  difficulty?: number;
  /** SemRush 平均 CPC（USD） */
  avgCpc?: number;
  /** 来源 */
  source: "semrush" | "crawl" | "history" | "industry" | "ai_inferred";
  /** 该来源给的原始优先级（越低越好） */
  sourcePriority: number;
}

export type MatchType =
  | "EXACT"
  | "PHRASE"
  | "BROAD"
  | "BROAD_MODIFIER";

export interface KeywordWithMatchType {
  text: string;
  matchType: MatchType;
  /** 内部得分 0-100，用于排序与诊断 */
  score: number;
  source: KeywordCandidate["source"];
  searchVolume?: number;
  difficulty?: number;
}

export interface KeywordIntelligenceContext {
  merchantName: string;
  finalUrl: string;
  targetCountry: string;
  profile: MerchantIntelligenceProfile;
  /** Step 5 候选词原始输入 — 来自 generate-extensions 已经准备好的多源候选 */
  candidates: KeywordCandidate[];
  /** campaigns.daily_budget（已乘币种归一化），单位美元（USD） */
  dailyBudgetUsd: number;
  /** campaigns.max_cpc（已乘币种归一化），单位美元（USD） */
  maxCpcUsd: number;
  /** 黑名单（来自 Step 4 PolicyPreflight） */
  blockedKeywords?: string[];
  /** 输出关键词数量上限，默认 12 */
  maxKeywords?: number;
}

export interface KeywordIntelligenceResult {
  keywords: KeywordWithMatchType[];
  matchTypeMix: Record<MatchType, number>;
  notes: string[];
}

/** 32 行业 → 通用关键词模板（每行业 3-6 个英文通用词） */
const INDUSTRY_GENERIC_KEYWORDS: Partial<Record<IndustryCategory, string[]>> = {
  Apparel_Accessories: ["online clothing store", "fashion deals", "buy clothes online", "outfit ideas"],
  Beauty_Personal_Care: ["beauty products online", "skincare deals", "makeup store", "personal care products"],
  Electronics_Appliances: ["home appliances online", "buy electronics", "discount electronics", "smart devices"],
  Computers_Electronics: ["buy laptop online", "best electronics", "gadget deals", "tech accessories"],
  Furniture_Home: ["home decor store", "modern furniture", "buy furniture online", "interior design ideas"],
  Home_Garden: ["home and garden products", "outdoor decor", "garden supplies", "home essentials"],
  Food_Beverage: ["gourmet food online", "specialty drinks", "snack delivery", "beverage store"],
  Jewelry_Watches: ["fine jewelry online", "designer watches", "buy rings online", "gold jewelry"],
  Sporting_Goods: ["sports equipment store", "fitness gear online", "outdoor sports", "athletic supplies"],
  Toys_Games: ["online toy store", "kids toys", "board games online", "buy games"],
  Travel_Hospitality: ["book trip online", "vacation deals", "travel packages", "best hotels"],
  Baby_Toddler: ["baby store online", "infant products", "kids essentials", "baby gear"],
  Animals_Pet: ["pet supplies online", "dog accessories", "cat food delivery", "pet store"],
  Healthcare_Pharmacy: ["health products online", "wellness supplements", "vitamins online", "pharmacy delivery"],
  Books_Media: ["books online", "e-books store", "audiobook subscription"],
  Software_Apps: ["productivity app", "online software", "saas tools", "best apps"],
  Automotive: ["car accessories online", "auto parts", "vehicle care products"],
  Cameras_Optics: ["buy camera online", "photo gear", "lens deals"],
  Vehicles_Parts: ["vehicle parts online", "auto accessories", "car components"],
  Office_Supplies: ["office supplies online", "stationery store", "business supplies"],
  Hardware_Tools: ["hardware tools online", "power tools store", "diy supplies"],
  Crafts_Hobbies: ["craft supplies online", "hobby store", "diy materials"],
  Arts_Entertainment: ["entertainment online", "art supplies", "creative gear"],
  Dating_Services: ["online dating", "find a match", "dating app"],
  Other: ["online store", "buy online", "shop deals"],
};

export function runKeywordIntelligence(
  ctx: KeywordIntelligenceContext,
): KeywordIntelligenceResult {
  const maxKeywords = ctx.maxKeywords ?? 12;
  const blockedSet = new Set(
    (ctx.blockedKeywords ?? []).map((k) => k.toLowerCase().trim()),
  );
  const merchantBrandTokens = new Set(
    ctx.merchantName.toLowerCase().split(/\s+/).filter((t) => t.length >= 3),
  );

  // 1) 加入行业基准
  const enriched: KeywordCandidate[] = [...ctx.candidates];
  if (ctx.profile.industry_category) {
    const industryGeneric =
      INDUSTRY_GENERIC_KEYWORDS[ctx.profile.industry_category] ??
      INDUSTRY_GENERIC_KEYWORDS.Other ??
      [];
    for (const word of industryGeneric) {
      enriched.push({
        text: word,
        source: "industry",
        sourcePriority: 4,
      });
    }
  }

  // 2) 去重 + 过滤黑名单 + 长度过滤
  const seen = new Set<string>();
  const filtered: KeywordCandidate[] = [];
  for (const c of enriched) {
    const norm = c.text.trim().toLowerCase();
    if (!norm || norm.length < 3 || norm.length > 80) continue;
    if (seen.has(norm)) continue;
    if (blockedSet.has(norm)) continue;
    // 商标策略：block_brand 时过滤包含品牌名 token 的关键词
    if (
      blockedSet.has(ctx.merchantName.toLowerCase()) &&
      [...merchantBrandTokens].some((t) => norm.includes(t))
    ) {
      continue;
    }
    seen.add(norm);
    filtered.push(c);
  }

  // 3) 打分（综合考虑 source 权重 + SemRush 数据 + 与行业匹配度）
  const sourceWeight: Record<KeywordCandidate["source"], number> = {
    semrush: 100,
    crawl: 80,
    history: 70,
    industry: 50,
    ai_inferred: 40,
  };

  const scored = filtered.map((c) => {
    let score = sourceWeight[c.source];
    if (c.searchVolume !== undefined) {
      // 月搜索量 1K-10K 最甜区，>50K 太热不推
      const sv = c.searchVolume;
      if (sv >= 1000 && sv <= 10000) score += 20;
      else if (sv > 10000 && sv <= 50000) score += 10;
      else if (sv > 50000) score -= 10;
    }
    if (c.difficulty !== undefined) {
      // kd 越低越好
      if (c.difficulty < 30) score += 15;
      else if (c.difficulty < 50) score += 5;
      else if (c.difficulty > 70) score -= 15;
    }
    return { c, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, maxKeywords);

  // 4) 三因子 match type 决策（X4=C 拍板）
  const decideMatchType = (kw: KeywordCandidate): MatchType => {
    const kd = kw.difficulty ?? 50;
    if (ctx.dailyBudgetUsd < 10 || ctx.maxCpcUsd > 1.5 || kd > 70) {
      return "EXACT";
    }
    if (ctx.dailyBudgetUsd < 30 || kd > 40) {
      // 中等预算 + 中等竞争 → 一半 phrase 一半 exact
      return "PHRASE";
    }
    // 大预算 + 低竞争 → 覆盖广（broad + phrase + exact 各部分）
    return "BROAD";
  };

  // 5) 输出 + 分配 match type，按 source 适配
  const matchTypeMix: Record<MatchType, number> = {
    EXACT: 0,
    PHRASE: 0,
    BROAD: 0,
    BROAD_MODIFIER: 0,
  };
  const out: KeywordWithMatchType[] = top.map((s, idx) => {
    let mt = decideMatchType(s.c);
    // 同一 batch 中混合策略：前 30% exact，中 50% phrase，后 20% broad（仅大预算情形）
    if (ctx.dailyBudgetUsd >= 30 && (s.c.difficulty ?? 50) < 40) {
      const pos = idx / Math.max(top.length - 1, 1);
      mt = pos < 0.3 ? "EXACT" : pos < 0.8 ? "PHRASE" : "BROAD";
    }
    matchTypeMix[mt] += 1;
    return {
      text: s.c.text,
      matchType: mt,
      score: Math.round(s.score),
      source: s.c.source,
      searchVolume: s.c.searchVolume,
      difficulty: s.c.difficulty,
    };
  });

  const notes: string[] = [];
  notes.push(
    `Budget=$${ctx.dailyBudgetUsd.toFixed(2)}/day, MaxCPC=$${ctx.maxCpcUsd.toFixed(2)} → match type 策略：${ctx.dailyBudgetUsd < 10 ? "EXACT only (节约预算)" : ctx.dailyBudgetUsd < 30 ? "PHRASE + EXACT 混合" : "BROAD + PHRASE + EXACT 全覆盖（高预算）"}`,
  );
  if (blockedSet.size > 0) {
    notes.push(`已过滤黑名单关键词 ${blockedSet.size} 条（政策避障）`);
  }

  return {
    keywords: out,
    matchTypeMix,
    notes,
  };
}
