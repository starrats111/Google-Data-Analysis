"""
Claude L7D 深度分析服务 (OPT-010)
采用组合模式复用 ClaudeService 的 API 客户端和 fallback 机制。
"""
import json
import os
import logging
from datetime import datetime
from typing import Dict, List, Optional, Any

logger = logging.getLogger(__name__)

PROMPT_FILE = os.path.join(
    os.path.dirname(__file__), "..", "..", "excel", "l7d_claude_prompt.txt"
)


class ClaudeAnalysisService:
    """L7D 专用 Claude 分析服务，组合 ClaudeService 实例"""

    def __init__(self, claude_service):
        self.claude = claude_service

    def generate_l7d_report(
        self,
        comparison_table: str,
        anomalies: List[Dict],
        cpa_diagnosis: Optional[Dict],
        budget_analysis: List[Dict],
    ) -> Dict[str, Any]:
        """
        构建结构化提示词并调用 Claude 生成 L7D 深度分析报告。

        Returns:
            {"success": True, "analysis": str, "ai_engine": "claude", ...}
        """
        prompt = self._build_prompt(
            comparison_table, anomalies, cpa_diagnosis, budget_analysis
        )

        try:
            response = self.claude._call_api_with_fallback(
                max_tokens=4096,
                messages=[{"role": "user", "content": prompt}],
            )

            analysis_text = ""
            for block in response.content:
                if hasattr(block, "text"):
                    analysis_text += block.text

            return {
                "success": True,
                "analysis": analysis_text,
                "ai_engine": "claude",
                "model_used": self.claude.current_model,
                "analysis_date": datetime.now().strftime("%Y-%m-%d"),
                "timestamp": datetime.now().isoformat(),
            }
        except Exception as e:
            logger.error(f"[ClaudeAnalysis] Claude API 调用失败: {e}")
            return {"success": False, "message": str(e), "ai_engine": "claude"}

    def _build_prompt(
        self,
        comparison_table: str,
        anomalies: List[Dict],
        cpa_diagnosis: Optional[Dict],
        budget_analysis: List[Dict],
    ) -> str:
        template = self._load_prompt_template()

        today = datetime.now()
        weekday_names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]

        anomaly_section = self._format_anomalies(anomalies)
        cpa_section = self._format_cpa(cpa_diagnosis)
        budget_section = self._format_budget(budget_analysis)

        prompt = f"""{template}

══════════════════════════════════════
【今日日期】{today.strftime('%Y-%m-%d')} {weekday_names[today.weekday()]}
══════════════════════════════════════

【广告系列当期 vs 上期对比数据】
{comparison_table}

【异常检测结果】
{anomaly_section}

【CPA 诊断结果】
{cpa_section}

【预算效率分析结果】
{budget_section}

请按模板要求生成 6 个 Section 的结构化分析报告。"""

        return prompt

    def _load_prompt_template(self) -> str:
        try:
            with open(PROMPT_FILE, "r", encoding="utf-8") as f:
                return f.read()
        except FileNotFoundError:
            logger.warning(
                f"[ClaudeAnalysis] 提示词模板未找到: {PROMPT_FILE}，使用内置模板"
            )
            return self._default_template()

    @staticmethod
    def _format_anomalies(anomalies: List[Dict]) -> str:
        if not anomalies:
            return "无异常检测到。"

        lines = [f"共检测到 {len(anomalies)} 项异常：\n"]
        for a in anomalies:
            severity_label = {"critical": "🔴严重", "warning": "🟡警告", "info": "🔵提示"}.get(
                a.get("severity", ""), "⚪"
            )
            lines.append(
                f"- [{severity_label}] {a['campaign_name']} | "
                f"{a['metric']} = {a['current_value']}（基线 {a['baseline_avg']} ± {a['baseline_std']}）| "
                f"偏离 {a['deviation_pct']}% | 可能原因：{a.get('likely_cause', '未知')} | "
                f"估算影响：${a.get('estimated_impact_usd', 0):.2f}"
            )
        return "\n".join(lines)

    @staticmethod
    def _format_cpa(cpa_diagnosis: Optional[Dict]) -> str:
        if not cpa_diagnosis:
            return "CPA 变化未超过 15% 阈值，无需诊断。"

        diag = cpa_diagnosis.get("cpa_diagnosis", cpa_diagnosis)
        lines = [
            f"当前 CPA: ${diag['current_cpa']:.2f}  |  上期 CPA: ${diag['previous_cpa']:.2f}  |  "
            f"变化: {diag['change_pct']:+.1f}%\n",
            "归因因素：",
        ]
        for f in diag.get("factors", []):
            lines.append(
                f"  - {f['factor']}（贡献 {f['contribution_pct']}%）: {f['detail']}  →  {f['fix']}"
            )
        return "\n".join(lines)

    @staticmethod
    def _format_budget(budget_analysis: List[Dict]) -> str:
        if not budget_analysis:
            return "无预算优化建议。"

        lines = ["预算优化建议：\n"]
        for b in budget_analysis:
            lines.append(
                f"- {b['campaign_name']}: 当前 ${b['current_daily_budget']:.2f} → "
                f"推荐 ${b['recommended_daily_budget']:.2f}（{b['change']}）| "
                f"理由：{b['reason']} | 预计 ROI 变化：{b['projected_roi_change']}"
            )
        return "\n".join(lines)

    @staticmethod
    def _default_template() -> str:
        return """你是一位拥有 10 年以上经验的跨境电商 Google Ads 投放专家。

请根据以下数据生成专业的 L7D 深度分析报告，包含 6 个结构化 Section：

## Section 1: 异常警报
按严重程度排序，附金额影响估算。

## Section 2: CPA 变化归因
Top 因素 + 贡献百分比 + 修复优先级。

## Section 3: 预算优化建议
各 campaign 推荐预算 + 预计 ROI 变化。

## Section 4: 出价策略建议
基于转化量判断手动/自动出价适配性。

## Section 5: 整体战略洞察
市场趋势、节日预判、竞争环境。

## Section 6: 优先行动清单
按「紧急+影响大」排序的 Top 5 行动。

报告应专业、有数据支撑、建议可执行。"""
