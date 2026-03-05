"""
CPA 诊断归因模块 (OPT-010)
当整体 CPA 周环比变化超过 15% 时自动触发，
拆解 CPA 变化为 CPC 变化、CVR 变化、预算分配偏移三个因素。
"""
import logging
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

CPA_CHANGE_THRESHOLD = 0.15


class CpaDiagnostics:
    """CPA 变化多因素归因诊断"""

    def diagnose(
        self,
        current_data: Dict[str, Dict],
        previous_data: Dict[str, Dict],
    ) -> Optional[Dict]:
        """
        对比当前 7 天 vs 上一个 7 天数据，拆解 CPA 变化。

        Args:
            current_data:  {campaign_name: {cost, clicks, orders, commission}}
            previous_data: {campaign_name: {cost, clicks, orders, commission}}

        Returns:
            诊断结果字典，或 None（若不满足触发条件）
        """
        cur_totals = self._aggregate(current_data)
        prev_totals = self._aggregate(previous_data)

        if cur_totals["orders"] == 0 or prev_totals["orders"] == 0:
            logger.info("[CPA] 当期或上期总订单为 0，跳过 CPA 诊断")
            return None

        current_cpa = cur_totals["cost"] / cur_totals["orders"]
        previous_cpa = prev_totals["cost"] / prev_totals["orders"]

        if previous_cpa == 0:
            return None

        change_pct = (current_cpa - previous_cpa) / previous_cpa

        if abs(change_pct) < CPA_CHANGE_THRESHOLD:
            logger.info(
                f"[CPA] CPA 变化 {change_pct:.1%} 未超过 {CPA_CHANGE_THRESHOLD:.0%} 阈值，跳过"
            )
            return None

        factors = self._attribute(
            cur_totals, prev_totals, current_data, previous_data
        )

        return {
            "cpa_diagnosis": {
                "current_cpa": round(current_cpa, 2),
                "previous_cpa": round(previous_cpa, 2),
                "change_pct": round(change_pct * 100, 1),
                "factors": factors,
            }
        }

    def _attribute(
        self,
        cur_t: Dict,
        prev_t: Dict,
        current_data: Dict[str, Dict],
        previous_data: Dict[str, Dict],
    ) -> List[Dict]:
        factors: List[Dict] = []

        old_cpa = prev_t["cost"] / prev_t["orders"]
        new_cpc = cur_t["cost"] / cur_t["clicks"] if cur_t["clicks"] else 0
        old_cpc = prev_t["cost"] / prev_t["clicks"] if prev_t["clicks"] else 0
        new_cvr = cur_t["orders"] / cur_t["clicks"] if cur_t["clicks"] else 0
        old_cvr = prev_t["orders"] / prev_t["clicks"] if prev_t["clicks"] else 0

        total_cpa_change = (cur_t["cost"] / cur_t["orders"]) - old_cpa
        if total_cpa_change == 0:
            return factors

        # Factor 1: CPC change contribution
        if old_cpa > 0:
            cpc_contribution = (new_cpc - old_cpc) / old_cpa
            cpc_pct = abs(cpc_contribution) / abs(total_cpa_change / old_cpa) * 100 if total_cpa_change != 0 else 0
            factors.append({
                "factor": "CPC上升" if new_cpc > old_cpc else "CPC下降",
                "contribution_pct": round(min(cpc_pct, 100), 0),
                "detail": f"平均CPC从${old_cpc:.2f}{'升' if new_cpc > old_cpc else '降'}至${new_cpc:.2f}",
                "fix": "检查竞争环境，考虑降低出价或优化QS" if new_cpc > old_cpc else "CPC 下降有利于降低获客成本",
            })

        # Factor 2: CVR change contribution
        if old_cvr > 0 and new_cvr > 0 and old_cpc > 0:
            cvr_cpa_old = old_cpc / old_cvr
            cvr_cpa_new = old_cpc / new_cvr
            cvr_contribution = cvr_cpa_new - cvr_cpa_old
            cvr_pct = abs(cvr_contribution) / abs(total_cpa_change) * 100 if total_cpa_change != 0 else 0
            factors.append({
                "factor": "CVR下降" if new_cvr < old_cvr else "CVR上升",
                "contribution_pct": round(min(cvr_pct, 100), 0),
                "detail": f"转化率从{old_cvr*100:.1f}%{'降' if new_cvr < old_cvr else '升'}至{new_cvr*100:.1f}%",
                "fix": "检查落地页和广告相关性" if new_cvr < old_cvr else "转化率改善，继续保持",
            })

        # Factor 3: Budget allocation shift
        allocation_impact = self._budget_allocation_impact(
            current_data, previous_data, cur_t, prev_t
        )
        if allocation_impact is not None:
            alloc_pct = abs(allocation_impact["value"]) / abs(total_cpa_change) * 100 if total_cpa_change != 0 else 0
            factors.append({
                "factor": "预算偏移",
                "contribution_pct": round(min(alloc_pct, 100), 0),
                "detail": allocation_impact["detail"],
                "fix": "重新分配预算到高效campaign",
            })

        # Normalize percentages to sum to ~100
        total_pct = sum(f["contribution_pct"] for f in factors)
        if total_pct > 0:
            for f in factors:
                f["contribution_pct"] = round(f["contribution_pct"] / total_pct * 100)

        factors.sort(key=lambda x: -x["contribution_pct"])
        return factors

    def _budget_allocation_impact(
        self,
        current_data: Dict[str, Dict],
        previous_data: Dict[str, Dict],
        cur_t: Dict,
        prev_t: Dict,
    ) -> Optional[Dict]:
        total_cur_cost = cur_t["cost"]
        total_prev_cost = prev_t["cost"]
        if total_cur_cost == 0 or total_prev_cost == 0:
            return None

        impact = 0.0
        worst_campaign = ""
        worst_shift = 0.0

        all_campaigns = set(current_data.keys()) | set(previous_data.keys())
        for name in all_campaigns:
            cur = current_data.get(name, {})
            prev = previous_data.get(name, {})
            cur_cost = cur.get("cost", 0) or 0
            prev_cost = prev.get("cost", 0) or 0
            cur_orders = cur.get("orders", 0) or 0

            cur_share = cur_cost / total_cur_cost if total_cur_cost else 0
            prev_share = prev_cost / total_prev_cost if total_prev_cost else 0
            share_change = cur_share - prev_share

            campaign_cpa = cur_cost / cur_orders if cur_orders > 0 else 0
            impact += share_change * campaign_cpa

            if share_change > worst_shift and campaign_cpa > 0:
                worst_shift = share_change
                worst_campaign = name

        if abs(impact) < 0.01:
            return None

        detail = f"低效campaign {worst_campaign} 花费占比上升{worst_shift*100:.0f}%" if worst_campaign else "花费分配发生偏移"
        return {"value": impact, "detail": detail}

    @staticmethod
    def _aggregate(data: Dict[str, Dict]) -> Dict:
        total = {"cost": 0.0, "clicks": 0, "orders": 0, "commission": 0.0}
        for d in data.values():
            total["cost"] += d.get("cost", 0) or 0
            total["clicks"] += d.get("clicks", 0) or 0
            total["orders"] += d.get("orders", 0) or 0
            total["commission"] += d.get("commission", 0) or 0
        return total
