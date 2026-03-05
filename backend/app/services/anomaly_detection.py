"""
L7D 异常检测模块 (OPT-010)
基于 14 天滚动均值 + 标准差的统计异常检测
"""
import math
import logging
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

SEVERITY_THRESHOLDS = {
    "critical": 3.0,
    "warning": 2.0,
    "info": 1.5,
}

CAUSE_RULES = [
    {
        "conditions": {"cpc": "high", "is_rank_lost": "high"},
        "cause": "竞争对手加价",
    },
    {
        "conditions": {"ctr": "low", "impressions": "normal"},
        "cause": "广告疲劳 / 相关性下降",
    },
    {
        "conditions": {"cost": "high", "clicks": "normal"},
        "cause": "CPC 异常升高",
    },
    {
        "conditions": {"is_budget_lost": "high"},
        "cause": "预算不足",
    },
    {
        "conditions": {"cost": "low", "impressions": "low"},
        "cause": "广告被暂停或审核拒绝",
    },
]

MIN_DATA_DAYS = 7


class AnomalyDetector:
    """统计异常检测器：14 天滚动均值 ± N 倍标准差"""

    METRICS = ["cpc", "ctr", "cost", "is_budget_lost", "is_rank_lost"]

    def detect(self, daily_data: Dict[str, List[Dict]]) -> List[Dict]:
        """
        对每个 campaign 的逐日数据进行异常检测。

        Args:
            daily_data: {campaign_name: [{date, campaign_id, cpc, ctr, cost,
                          is_budget_lost, is_rank_lost, ...}, ...]}
                        按日期升序排列，最多 30 天。

        Returns:
            异常列表，每项包含 campaign_id, campaign_name, metric,
            current_value, baseline_avg, baseline_std, deviation_pct,
            severity, likely_cause, estimated_impact_usd
        """
        all_anomalies: List[Dict] = []

        for campaign_name, records in daily_data.items():
            if len(records) < MIN_DATA_DAYS:
                continue

            last_14 = records[-14:] if len(records) >= 14 else records
            latest = records[-1]
            campaign_id = latest.get("campaign_id", "")

            campaign_anomalies: Dict[str, str] = {}

            for metric in self.METRICS:
                values = [r.get(metric, 0) or 0 for r in last_14[:-1]]
                if not values:
                    continue

                avg = sum(values) / len(values)
                variance = sum((v - avg) ** 2 for v in values) / len(values)
                std = math.sqrt(variance) if variance > 0 else 0

                current = latest.get(metric, 0) or 0

                if std == 0:
                    if current != avg and avg != 0:
                        deviation_ratio = abs(current - avg) / abs(avg) * 2
                    else:
                        continue
                else:
                    deviation_ratio = abs(current - avg) / std

                severity = self._classify_severity(deviation_ratio)
                if severity is None:
                    continue

                direction = "high" if current > avg else "low"
                campaign_anomalies[metric] = direction

                deviation_pct = ((current - avg) / avg * 100) if avg != 0 else 0
                impact = self._estimate_impact(metric, current, avg, latest)

                all_anomalies.append({
                    "campaign_id": campaign_id,
                    "campaign_name": campaign_name,
                    "metric": metric,
                    "current_value": round(current, 4),
                    "baseline_avg": round(avg, 4),
                    "baseline_std": round(std, 4),
                    "deviation_pct": round(deviation_pct, 1),
                    "severity": severity,
                    "likely_cause": self._infer_cause(campaign_anomalies),
                    "estimated_impact_usd": round(impact, 2),
                })

            if campaign_anomalies:
                cause = self._infer_cause(campaign_anomalies)
                for a in all_anomalies:
                    if a["campaign_name"] == campaign_name:
                        a["likely_cause"] = cause

        all_anomalies.sort(
            key=lambda x: (
                {"critical": 0, "warning": 1, "info": 2}.get(x["severity"], 3),
                -abs(x["deviation_pct"]),
            )
        )
        return all_anomalies

    @staticmethod
    def _classify_severity(deviation_ratio: float) -> Optional[str]:
        if deviation_ratio >= SEVERITY_THRESHOLDS["critical"]:
            return "critical"
        if deviation_ratio >= SEVERITY_THRESHOLDS["warning"]:
            return "warning"
        if deviation_ratio >= SEVERITY_THRESHOLDS["info"]:
            return "info"
        return None

    @staticmethod
    def _infer_cause(anomaly_directions: Dict[str, str]) -> str:
        for rule in CAUSE_RULES:
            match = True
            for metric, expected in rule["conditions"].items():
                actual = anomaly_directions.get(metric)
                if expected == "normal":
                    if actual is not None:
                        match = False
                        break
                else:
                    if actual != expected:
                        match = False
                        break
            if match:
                return rule["cause"]
        return "指标异常波动"

    @staticmethod
    def _estimate_impact(
        metric: str, current: float, avg: float, latest_record: Dict
    ) -> float:
        diff = abs(current - avg)
        if metric == "cpc":
            clicks = latest_record.get("clicks", 0) or 0
            return diff * clicks
        if metric == "cost":
            return diff
        if metric == "is_budget_lost":
            cost = latest_record.get("cost", 0) or 0
            return diff * cost if cost > 0 else 0
        return 0.0
