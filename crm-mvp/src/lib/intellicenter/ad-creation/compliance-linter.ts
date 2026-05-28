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
  type ComplianceCheckResult,
  type ComplianceViolation,
} from "@/lib/ad-compliance-checker";
import type { IndustryProfile } from "@/lib/industry-profile";

export interface LinterContext {
  merchantName: string;
  industryProfile?: IndustryProfile | null;
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
