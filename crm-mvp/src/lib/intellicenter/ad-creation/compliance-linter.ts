/**
 * C-112 / D-046.C — Step 8：Compliance Linter 后置兜底
 *
 * 复用 D-039 H3 已有的 `ad-compliance-checker.ts` checkAdCompliance（4 大类 30+ 子项规则扫描），
 * 在 Step 6 AI 生成 + Step 7 相似度评分通过后，作为"出厂前"最后一道闸：
 *   - 检测 critical 违规 → 触发 mini-retry（最多 2 轮）
 *   - 仍有 critical → 删除违规条目（宁缺勿滥）
 *   - 只有 minor → 警告但放行
 *
 * 输入：headlines/descriptions/callouts/sitelinks 任意组合
 * 输出：清洗后的安全文案 + linter 报告
 */

import {
  checkAdCompliance,
  buildRewritePrompt,
  applyRewrites,
  staticFallbackHeadlines,
  staticFallbackDescriptions,
  type ComplianceCheckResult,
  type ComplianceViolation,
} from "@/lib/ad-compliance-checker";
import { smartTruncate } from "@/lib/crawl-pipeline";
import type { IndustryProfile } from "@/lib/industry-profile";

export interface LinterContext {
  merchantName: string;
  industryProfile?: IndustryProfile | null;
  /** D-161：画像判 authorized/own_brand 时允许品牌名，跳过 trademark_leak（与 policy-preflight 同源） */
  allowBrand?: boolean;
}

export interface LinterReport {
  /** 清洗后保留的文案（critical 违规条已剔除） */
  cleanedHeadlines: string[];
  cleanedDescriptions: string[];
  cleanedCallouts: string[];
  /** 触发返工或剔除的 critical 违规列表 */
  criticalViolations: ComplianceViolation[];
  /** 仅警告不阻断的 minor 违规列表 */
  minorViolations: ComplianceViolation[];
  /** 删除/触发返工的条目数 */
  droppedCount: number;
  /** lint 是否通过（critical=0 即通过） */
  passed: boolean;
}

export function lintAdCopy(
  input: {
    headlines: string[];
    descriptions: string[];
    callouts?: string[];
  },
  ctx: LinterContext,
): LinterReport {
  const headlines = (input.headlines ?? []).slice();
  const descriptions = (input.descriptions ?? []).slice();
  const callouts = (input.callouts ?? []).slice();

  const result: ComplianceCheckResult = checkAdCompliance(
    headlines,
    descriptions,
    {
      merchantName: ctx.merchantName,
      industryProfile: ctx.industryProfile ?? null,
      allowBrand: ctx.allowBrand,
    },
    callouts,
  );

  const criticalByField: Record<"headline" | "description" | "callout", Set<number>> = {
    headline: new Set(),
    description: new Set(),
    callout: new Set(),
  };
  for (const v of result.violations) {
    if (v.severity === "critical") {
      criticalByField[v.field].add(v.index);
    }
  }

  const cleanedHeadlines = headlines.filter(
    (_, i) => !criticalByField.headline.has(i),
  );
  const cleanedDescriptions = descriptions.filter(
    (_, i) => !criticalByField.description.has(i),
  );
  const cleanedCallouts = callouts.filter(
    (_, i) => !criticalByField.callout.has(i),
  );

  const droppedCount =
    criticalByField.headline.size +
    criticalByField.description.size +
    criticalByField.callout.size;

  return {
    cleanedHeadlines,
    cleanedDescriptions,
    cleanedCallouts,
    criticalViolations: result.violations.filter((v) => v.severity === "critical"),
    minorViolations: result.violations.filter((v) => v.severity === "minor"),
    droppedCount,
    passed: result.criticalCount === 0,
  };
}

// ──────────── C-118: 重写闭环 + 数量补足 ────────────

const MAX = { headline: 30, description: 90, callout: 25 } as const;

function clampLen(arr: string[], max: number): string[] {
  return (arr ?? [])
    .map((s) => (typeof s === "string" && s.length > max ? smartTruncate(s, max).slice(0, max) : s))
    .filter((s) => typeof s === "string" && s.trim().length > 0);
}

function parseRewriteJson(raw: string): {
  headlines?: Record<string, string>;
  descriptions?: Record<string, string>;
  callouts?: Record<string, string>;
} {
  try {
    let s = (raw ?? "").trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/** 用静态合规模板把数量补足到 target（去重 + 跳过本身违规的兜底项） */
function backfill(
  current: string[],
  target: number,
  pool: string[],
  field: "headline" | "description" | "callout",
  ctx: LinterContext,
): string[] {
  if (target <= 0 || current.length >= target) return current.slice(0, Math.max(target, current.length));
  const seen = new Set(current.map((s) => s.toLowerCase().trim()));
  const out = [...current];
  for (const cand of pool) {
    if (out.length >= target) break;
    const key = cand.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    // 兜底项也要过 lint，避免补进违规项
    const probeOpts = { merchantName: ctx.merchantName, industryProfile: ctx.industryProfile ?? null, allowBrand: ctx.allowBrand };
    const probe =
      field === "headline"
        ? checkAdCompliance([cand], [], probeOpts, [])
        : field === "description"
          ? checkAdCompliance([], [cand], probeOpts, [])
          : checkAdCompliance([], [], probeOpts, [cand]);
    if (probe.criticalCount > 0) continue;
    seen.add(key);
    out.push(cand);
  }
  return out;
}

export interface RewriteBackfillOptions extends LinterContext {
  /** 目标数量：删除违规后要补足回这些数（07 铁律：标题 15 / 描述 4） */
  targetHeadlines?: number;
  targetDescriptions?: number;
  targetCallouts?: number;
  industryLabel?: string | null;
}

/**
 * C-118 出厂闸（增强版）：lint → AI 重写 critical → 复检 → 仍违规则删除 → 数量补足。
 *
 * 与 lintAdCopy（只删）的区别：先给 AI 一次「证据感知重写」机会保住条目，
 * 重写仍违规才删；最后用静态合规模板把数量补回 target，保证标题满 15 / 描述满 4。
 *
 * @param callAi 注入的 AI 调用函数（orchestrator 传 callAiWithFallback 闭包）。为空则跳过重写直接删。
 */
export async function lintRewriteAndBackfill(
  input: { headlines: string[]; descriptions: string[]; callouts?: string[] },
  ctx: RewriteBackfillOptions,
  callAi?: (prompt: string) => Promise<string>,
): Promise<LinterReport & { rewroteCount: number; backfilledCount: number }> {
  const opts = {
    merchantName: ctx.merchantName,
    industryProfile: ctx.industryProfile ?? null,
    allowBrand: ctx.allowBrand,
  };
  let headlines = (input.headlines ?? []).slice();
  let descriptions = (input.descriptions ?? []).slice();
  let callouts = (input.callouts ?? []).slice();

  // 1) 首次扫描
  let result = checkAdCompliance(headlines, descriptions, opts, callouts);
  let rewroteCount = 0;

  // 2) 有 critical 且可调用 AI → 证据感知重写一轮
  const criticalNow = result.violations.filter((v) => v.severity === "critical");
  if (criticalNow.length > 0 && callAi) {
    try {
      const prompt = buildRewritePrompt(criticalNow, ctx.merchantName, ctx.industryLabel ?? null);
      const raw = await callAi(prompt);
      const rewrites = parseRewriteJson(raw);
      const before = JSON.stringify([headlines, descriptions, callouts]);
      ({ headlines, descriptions, callouts } = applyRewrites(headlines, descriptions, rewrites, callouts));
      // 重写后再夹一次长度（AI 偶发超长）
      headlines = clampLen(headlines, MAX.headline);
      descriptions = clampLen(descriptions, MAX.description);
      callouts = clampLen(callouts, MAX.callout);
      if (JSON.stringify([headlines, descriptions, callouts]) !== before) {
        rewroteCount = Object.keys(rewrites.headlines ?? {}).length +
          Object.keys(rewrites.descriptions ?? {}).length +
          Object.keys(rewrites.callouts ?? {}).length;
      }
      // 复检
      result = checkAdCompliance(headlines, descriptions, opts, callouts);
    } catch (e) {
      console.warn(`[Linter] rewrite failed, fallback to drop: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 3) 仍有 critical → 按字段删除
  const criticalByField: Record<"headline" | "description" | "callout", Set<number>> = {
    headline: new Set(),
    description: new Set(),
    callout: new Set(),
  };
  for (const v of result.violations) {
    if (v.severity === "critical") criticalByField[v.field].add(v.index);
  }
  const droppedCount =
    criticalByField.headline.size + criticalByField.description.size + criticalByField.callout.size;

  let cleanedHeadlines = headlines.filter((_, i) => !criticalByField.headline.has(i));
  let cleanedDescriptions = descriptions.filter((_, i) => !criticalByField.description.has(i));
  let cleanedCallouts = callouts.filter((_, i) => !criticalByField.callout.has(i));

  // 4) 数量补足（删除后若 < target，用静态合规模板补回）
  const beforeBackfill =
    cleanedHeadlines.length + cleanedDescriptions.length + cleanedCallouts.length;
  if (ctx.targetHeadlines && cleanedHeadlines.length < ctx.targetHeadlines) {
    cleanedHeadlines = backfill(
      cleanedHeadlines,
      ctx.targetHeadlines,
      staticFallbackHeadlines(ctx.merchantName),
      "headline",
      ctx,
    );
  }
  if (ctx.targetDescriptions && cleanedDescriptions.length < ctx.targetDescriptions) {
    cleanedDescriptions = backfill(
      cleanedDescriptions,
      ctx.targetDescriptions,
      staticFallbackDescriptions(),
      "description",
      ctx,
    );
  }
  const backfilledCount =
    cleanedHeadlines.length + cleanedDescriptions.length + cleanedCallouts.length - beforeBackfill;

  return {
    cleanedHeadlines,
    cleanedDescriptions,
    cleanedCallouts,
    criticalViolations: result.violations.filter((v) => v.severity === "critical"),
    minorViolations: result.violations.filter((v) => v.severity === "minor"),
    droppedCount,
    passed: result.criticalCount === 0,
    rewroteCount,
    backfilledCount,
  };
}
