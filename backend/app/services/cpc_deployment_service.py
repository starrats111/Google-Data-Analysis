"""
一键部署CPC服务
计算关键词级别的CPC建议和预算建议
"""
from datetime import datetime
from typing import Dict, List, Optional, Tuple
from sqlalchemy.orm import Session
import logging

from app.models.keyword_bid import KeywordBid, CampaignBidStrategy
from app.models.google_ads_api_data import GoogleAdsApiData

logger = logging.getLogger(__name__)


class CPCDeploymentService:
    """CPC部署建议服务"""
    
    def __init__(self, db: Session):
        self.db = db
    
    def calculate_keyword_cpc_suggestions(
        self,
        user_id: int,
        campaign_name: str,
        conservative_epc: float,
        is_rank_lost: float = 0,
        current_budget: float = 0,
        conservative_roi: float = None
    ) -> Dict:
        """
        计算广告系列下所有关键词的CPC建议
        
        规则：
        1. 上限：不超过 保守EPC × 0.7（红线CPC）
        2. 修改区间：avg_cpc × 1.3 ~ avg_cpc × 1.5
        3. 周1、3、5 且 Rank丢失 > 15%：在修改区间基础上 +$0.02
        
        Args:
            user_id: 用户ID
            campaign_name: 广告系列名
            conservative_epc: 保守EPC
            is_rank_lost: 排名丢失比例 (0-1)
            current_budget: 当前预算
            conservative_roi: 保守ROI
            
        Returns:
            包含关键词CPC建议和预算建议的字典
        """
        # 计算红线CPC
        redline_cpc = conservative_epc * 0.7 if conservative_epc > 0 else 0
        
        # 检查今天是否为周1/3/5
        today = datetime.now()
        weekday = today.weekday()  # 0=周一, 2=周三, 4=周五
        is_boost_day = weekday in [0, 2, 4]
        should_boost = is_boost_day and is_rank_lost > 0.15
        
        # 查询该广告系列下的所有关键词
        keywords = self.db.query(KeywordBid).filter(
            KeywordBid.user_id == user_id,
            KeywordBid.campaign_name == campaign_name,
            KeywordBid.status == "ENABLED"
        ).all()
        
        keyword_suggestions = []
        
        for kw in keywords:
            current_cpc = kw.max_cpc or 0
            avg_cpc = kw.avg_cpc or current_cpc
            
            if avg_cpc <= 0:
                continue
            
            # 计算目标CPC（修改区间中间值）
            target_cpc = avg_cpc * 1.4  # 中间值
            
            # 周1/3/5 且 Rank丢失 > 15%：+0.02
            if should_boost:
                target_cpc += 0.02
            
            # 不超过红线CPC
            if redline_cpc > 0:
                target_cpc = min(target_cpc, redline_cpc)
            
            # 确保最小值为 $0.01
            target_cpc = max(target_cpc, 0.01)
            
            # 计算变化百分比
            if current_cpc > 0:
                change_percent = ((target_cpc - current_cpc) / current_cpc) * 100
            else:
                change_percent = 0
            
            # 只有当变化超过1%时才建议修改
            if abs(change_percent) > 1:
                keyword_suggestions.append({
                    "keyword_id": kw.criterion_id,
                    "keyword_text": kw.keyword_text,
                    "match_type": kw.match_type,
                    "current_cpc": round(current_cpc, 2),
                    "target_cpc": round(target_cpc, 2),
                    "change_percent": round(change_percent, 1),
                    "quality_score": kw.quality_score,
                    "ad_group_id": kw.ad_group_id,
                    "campaign_id": kw.campaign_id,
                    "customer_id": kw.customer_id,
                    "mcc_id": kw.mcc_id
                })
        
        # 计算预算建议
        budget_suggestion = self._calculate_budget_suggestion(
            current_budget=current_budget,
            conservative_roi=conservative_roi,
            is_budget_lost=0,  # 从外部传入
            is_rank_lost=is_rank_lost
        )
        
        return {
            "campaign_name": campaign_name,
            "redline_cpc": round(redline_cpc, 2),
            "is_boost_day": is_boost_day,
            "should_boost": should_boost,
            "keyword_suggestions": keyword_suggestions,
            "budget_suggestion": budget_suggestion
        }
    
    def _calculate_budget_suggestion(
        self,
        current_budget: float,
        conservative_roi: float = None,
        is_budget_lost: float = 0,
        is_rank_lost: float = 0,
        order_days: int = 0
    ) -> Optional[Dict]:
        """
        计算预算调整建议
        
        规则（从分析提示词）：
        - S级 Budget丢失>60%: 预算×2.0 (+100%)
        - S级 Budget丢失40-60%: 预算×1.3 (+30%)
        - B级 样本不足: 预算×1.3 (+30%)
        - D级: 暂停
        """
        if current_budget <= 0:
            return None
        
        # D级：ROI严重为负
        if conservative_roi is not None and conservative_roi < -0.4:
            return {
                "action": "pause",
                "current_budget": round(current_budget, 2),
                "target_budget": 0,
                "change_percent": -100,
                "reason": "ROI严重为负，建议暂停"
            }
        
        # S级判定（简化：ROI > 3）
        is_s_level = conservative_roi is not None and conservative_roi > 3 and order_days >= 5
        
        target_budget = current_budget
        change_percent = 0
        reason = "维持当前预算"
        
        if is_s_level:
            if is_budget_lost > 0.6:
                target_budget = current_budget * 2.0
                change_percent = 100
                reason = "S级，Budget丢失>60%"
            elif is_budget_lost > 0.4:
                target_budget = current_budget * 1.3
                change_percent = 30
                reason = "S级，Budget丢失40-60%"
        else:
            # B级处理
            if is_budget_lost > 0.3:
                target_budget = current_budget * 1.2
                change_percent = 20
                reason = "有预算瓶颈，适当增加"
        
        if change_percent == 0:
            return None
        
        return {
            "action": "adjust",
            "current_budget": round(current_budget, 2),
            "target_budget": round(target_budget, 2),
            "change_percent": round(change_percent, 1),
            "reason": reason
        }
    
    def generate_operation_instruction_with_keywords(
        self,
        user_id: int,
        campaign_name: str,
        conservative_epc: float,
        conservative_roi: float,
        is_budget_lost: float,
        is_rank_lost: float,
        current_budget: float,
        order_days: int = 0
    ) -> Tuple[str, Dict]:
        """
        生成包含关键词级别CPC的操作指令
        
        返回格式: [kw1] $0.50→$0.65 | [kw2] $0.60→$0.78 | 预算 $50→$65 (+30%)
        
        Returns:
            Tuple[操作指令字符串, 部署数据字典]
        """
        # D级判定：ROI严重为负
        if conservative_roi is not None and conservative_roi < -0.4:
            return "暂停", {
                "action": "pause",
                "campaign_name": campaign_name,
                "keyword_suggestions": [],
                "budget_suggestion": None
            }
        
        # 获取关键词CPC建议
        suggestions = self.calculate_keyword_cpc_suggestions(
            user_id=user_id,
            campaign_name=campaign_name,
            conservative_epc=conservative_epc,
            is_rank_lost=is_rank_lost,
            current_budget=current_budget,
            conservative_roi=conservative_roi
        )
        
        # 计算预算建议
        budget_suggestion = self._calculate_budget_suggestion(
            current_budget=current_budget,
            conservative_roi=conservative_roi,
            is_budget_lost=is_budget_lost,
            is_rank_lost=is_rank_lost,
            order_days=order_days
        )
        suggestions["budget_suggestion"] = budget_suggestion
        
        # 生成操作指令字符串
        instruction_parts = []
        
        # 添加关键词CPC建议
        for kw in suggestions.get("keyword_suggestions", []):
            keyword_text = kw["keyword_text"]
            # 截断过长的关键词
            if len(keyword_text) > 15:
                keyword_text = keyword_text[:12] + "..."
            instruction_parts.append(
                f"[{keyword_text}] ${kw['current_cpc']:.2f}→${kw['target_cpc']:.2f}"
            )
        
        # 添加预算建议
        if budget_suggestion:
            if budget_suggestion["action"] == "pause":
                instruction_parts.append("暂停")
            else:
                sign = "+" if budget_suggestion["change_percent"] > 0 else ""
                instruction_parts.append(
                    f"预算 ${budget_suggestion['current_budget']:.2f}→"
                    f"${budget_suggestion['target_budget']:.2f}"
                    f"({sign}{budget_suggestion['change_percent']:.0f}%)"
                )
        
        if not instruction_parts:
            instruction_str = "维持"
        else:
            instruction_str = " | ".join(instruction_parts)
        
        return instruction_str, suggestions
    
    def get_campaign_keywords(
        self,
        user_id: int,
        campaign_name: str
    ) -> List[Dict]:
        """
        获取广告系列下的所有关键词
        """
        keywords = self.db.query(KeywordBid).filter(
            KeywordBid.user_id == user_id,
            KeywordBid.campaign_name == campaign_name
        ).all()
        
        return [{
            "keyword_id": kw.criterion_id,
            "keyword_text": kw.keyword_text,
            "match_type": kw.match_type,
            "current_cpc": kw.max_cpc,
            "avg_cpc": kw.avg_cpc,
            "quality_score": kw.quality_score,
            "status": kw.status,
            "ad_group_id": kw.ad_group_id,
            "ad_group_name": kw.ad_group_name,
            "campaign_id": kw.campaign_id,
            "customer_id": kw.customer_id,
            "mcc_id": kw.mcc_id
        } for kw in keywords]

