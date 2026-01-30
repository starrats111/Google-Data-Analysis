"""
基于API数据的分析服务
从平台数据和Google Ads API数据自动生成每日分析和L7D分析
"""
from datetime import datetime, date, timedelta
from typing import Dict, List, Optional
from sqlalchemy.orm import Session
from sqlalchemy import func, and_, or_
import logging

from app.models.platform_data import PlatformData
from app.models.google_ads_api_data import GoogleAdsApiData
from app.models.affiliate_account import AffiliateAccount
from app.models.ad_campaign_daily_metric import AdCampaignDailyMetric
from app.models.ad_campaign import AdCampaign
from app.services.campaign_matcher import CampaignMatcher

logger = logging.getLogger(__name__)


class ApiAnalysisService:
    """基于API数据的分析服务"""
    
    def __init__(self, db: Session):
        self.db = db
        self.matcher = CampaignMatcher(db)
    
    def generate_daily_analysis(
        self,
        target_date: date,
        user_id: Optional[int] = None
    ) -> Dict:
        """
        生成指定日期的每日分析
        
        Args:
            target_date: 目标日期
            user_id: 用户ID（可选，如果提供则只分析该用户的数据）
        
        Returns:
            分析结果
        """
        try:
            # 1. 获取该日期的Google Ads数据
            google_ads_query = self.db.query(GoogleAdsApiData).filter(
                GoogleAdsApiData.date == target_date
            )
            
            if user_id:
                google_ads_query = google_ads_query.filter(
                    GoogleAdsApiData.user_id == user_id
                )
            
            google_ads_data = google_ads_query.all()
            
            # 2. 按平台和账号分组聚合Google Ads数据
            google_ads_by_account = {}
            for data in google_ads_data:
                platform_code = data.extracted_platform_code
                account_code = data.extracted_account_code
                
                if not platform_code:
                    continue
                
                # 查找对应的联盟账号
                affiliate_account = self._find_affiliate_account(
                    platform_code,
                    account_code,
                    data.user_id
                )
                
                if not affiliate_account:
                    continue
                
                key = affiliate_account.id
                
                if key not in google_ads_by_account:
                    google_ads_by_account[key] = {
                        "account": affiliate_account,
                        "campaigns": [],
                        "total_budget": 0,
                        "total_cost": 0,
                        "total_impressions": 0,
                        "total_clicks": 0,
                        "max_cpc": 0,
                        "is_budget_lost": 0,
                        "is_rank_lost": 0,
                    }
                
                google_ads_by_account[key]["campaigns"].append(data)
                google_ads_by_account[key]["total_budget"] += data.budget
                google_ads_by_account[key]["total_cost"] += data.cost
                google_ads_by_account[key]["total_impressions"] += data.impressions
                google_ads_by_account[key]["total_clicks"] += data.clicks
                google_ads_by_account[key]["max_cpc"] = max(
                    google_ads_by_account[key]["max_cpc"],
                    data.cpc
                )
                google_ads_by_account[key]["is_budget_lost"] = max(
                    google_ads_by_account[key]["is_budget_lost"],
                    data.is_budget_lost
                )
                google_ads_by_account[key]["is_rank_lost"] = max(
                    google_ads_by_account[key]["is_rank_lost"],
                    data.is_rank_lost
                )
            
            # 3. 获取该日期的平台数据
            platform_data_query = self.db.query(PlatformData).filter(
                PlatformData.date == target_date
            )
            
            if user_id:
                platform_data_query = platform_data_query.filter(
                    PlatformData.user_id == user_id
                )
            
            platform_data_list = platform_data_query.all()
            
            # 4. 合并数据并生成分析结果
            analysis_results = []
            
            for account_id, google_data in google_ads_by_account.items():
                # 查找对应的平台数据
                platform_data = next(
                    (pd for pd in platform_data_list if pd.affiliate_account_id == account_id),
                    None
                )
                
                account = google_data["account"]
                
                # 计算指标
                cost = google_data["total_cost"]
                clicks = google_data["total_clicks"]
                impressions = google_data["total_impressions"]
                cpc = clicks > 0 and cost / clicks or 0
                
                commission = platform_data.commission if platform_data else 0
                orders = platform_data.orders if platform_data else 0
                order_days_this_week = platform_data.order_days_this_week if platform_data else 0
                
                # 计算本周对比（需要查询本周其他日期的数据）
                week_start = target_date - timedelta(days=target_date.weekday())
                week_end = week_start + timedelta(days=6)
                
                week_cost = self.db.query(func.sum(PlatformData.commission)).filter(
                    PlatformData.affiliate_account_id == account_id,
                    PlatformData.date >= week_start,
                    PlatformData.date <= week_end
                ).scalar() or 0
                
                # 计算保守EPC和保守ROI
                conservative_epc = clicks > 0 and (commission * 0.72) / clicks or 0
                conservative_roi = cost > 0 and ((commission * 0.72 - cost) / cost) * 100 or 0
                
                # 生成操作指令
                operation_instruction = self._generate_operation_instruction(
                    cost, clicks, commission, orders, 
                    google_data["is_budget_lost"], google_data["is_rank_lost"],
                    order_days_this_week
                )
                
                # 保存到AdCampaignDailyMetric表（用于每日分析）
                # 这里需要为每个广告系列创建记录，但为了简化，我们先创建汇总记录
                # 实际应用中可能需要更细粒度的处理
                
                analysis_results.append({
                    "date": target_date.isoformat(),
                    "account_id": account_id,
                    "account_name": account.account_name,
                    "platform_name": account.platform.platform_name,
                    "campaign_count": len(google_data["campaigns"]),
                    "budget": google_data["total_budget"],
                    "cost": cost,
                    "impressions": impressions,
                    "clicks": clicks,
                    "cpc": cpc,
                    "max_cpc": google_data["max_cpc"],
                    "orders": orders,
                    "commission": commission,
                    "order_days_this_week": order_days_this_week,
                    "week_commission": week_commission,
                    "week_cost": week_cost_google,
                    "conservative_epc": conservative_epc,
                    "conservative_roi": conservative_roi,
                    "is_budget_lost": google_data["is_budget_lost"],
                    "is_rank_lost": google_data["is_rank_lost"],
                    "operation_instruction": operation_instruction,
                })
            
            return {
                "success": True,
                "date": target_date.isoformat(),
                "total_records": len(analysis_results),
                "results": analysis_results
            }
            
        except Exception as e:
            logger.error(f"生成每日分析失败: {e}")
            return {
                "success": False,
                "message": f"生成分析失败: {str(e)}"
            }
    
    def generate_l7d_analysis(
        self,
        end_date: date,
        user_id: Optional[int] = None
    ) -> Dict:
        """
        生成过去7天的L7D分析
        
        Args:
            end_date: 结束日期（通常是昨天）
            user_id: 用户ID（可选）
        
        Returns:
            L7D分析结果
        """
        try:
            begin_date = end_date - timedelta(days=6)  # 过去7天
            
            # 1. 获取过去7天的Google Ads数据
            google_ads_query = self.db.query(GoogleAdsApiData).filter(
                GoogleAdsApiData.date >= begin_date,
                GoogleAdsApiData.date <= end_date
            )
            
            if user_id:
                google_ads_query = google_ads_query.filter(
                    GoogleAdsApiData.user_id == user_id
                )
            
            google_ads_data = google_ads_query.all()
            
            # 2. 按平台和账号分组聚合
            google_ads_by_account = {}
            for data in google_ads_data:
                platform_code = data.extracted_platform_code
                account_code = data.extracted_account_code
                
                if not platform_code:
                    continue
                
                affiliate_account = self._find_affiliate_account(
                    platform_code,
                    account_code,
                    data.user_id
                )
                
                if not affiliate_account:
                    continue
                
                key = affiliate_account.id
                
                if key not in google_ads_by_account:
                    google_ads_by_account[key] = {
                        "account": affiliate_account,
                        "campaigns": [],
                        "dates": set(),
                        "total_budget": 0,
                        "total_cost": 0,
                        "total_impressions": 0,
                        "total_clicks": 0,
                        "max_cpc": 0,
                        "is_budget_lost": 0,
                        "is_rank_lost": 0,
                    }
                
                google_ads_by_account[key]["campaigns"].append(data)
                google_ads_by_account[key]["dates"].add(data.date)
                google_ads_by_account[key]["total_budget"] += data.budget
                google_ads_by_account[key]["total_cost"] += data.cost
                google_ads_by_account[key]["total_impressions"] += data.impressions
                google_ads_by_account[key]["total_clicks"] += data.clicks
                google_ads_by_account[key]["max_cpc"] = max(
                    google_ads_by_account[key]["max_cpc"],
                    data.cpc
                )
                google_ads_by_account[key]["is_budget_lost"] = max(
                    google_ads_by_account[key]["is_budget_lost"],
                    data.is_budget_lost
                )
                google_ads_by_account[key]["is_rank_lost"] = max(
                    google_ads_by_account[key]["is_rank_lost"],
                    data.is_rank_lost
                )
            
            # 3. 获取过去7天的平台数据
            platform_data_query = self.db.query(PlatformData).filter(
                PlatformData.date >= begin_date,
                PlatformData.date <= end_date
            )
            
            if user_id:
                platform_data_query = platform_data_query.filter(
                    PlatformData.user_id == user_id
                )
            
            platform_data_list = platform_data_query.all()
            
            # 4. 按账号聚合平台数据
            platform_data_by_account = {}
            for pd in platform_data_list:
                account_id = pd.affiliate_account_id
                if account_id not in platform_data_by_account:
                    platform_data_by_account[account_id] = {
                        "total_commission": 0,
                        "total_orders": 0,
                        "order_days": set(),
                    }
                
                platform_data_by_account[account_id]["total_commission"] += pd.commission
                platform_data_by_account[account_id]["total_orders"] += pd.orders
                if pd.orders > 0:
                    platform_data_by_account[account_id]["order_days"].add(pd.date)
            
            # 5. 生成L7D分析结果
            analysis_results = []
            
            for account_id, google_data in google_ads_by_account.items():
                platform_data = platform_data_by_account.get(account_id, {
                    "total_commission": 0,
                    "total_orders": 0,
                    "order_days": set(),
                })
                
                account = google_data["account"]
                
                # L7D指标
                l7d_cost = google_data["total_cost"]
                l7d_clicks = google_data["total_clicks"]
                l7d_impressions = google_data["total_impressions"]
                l7d_cpc = l7d_clicks > 0 and l7d_cost / l7d_clicks or 0
                l7d_commission = platform_data["total_commission"]
                l7d_orders = platform_data["total_orders"]
                l7d_order_days = len(platform_data["order_days"])
                
                # 计算保守EPC和保守ROI
                conservative_epc = l7d_clicks > 0 and (l7d_commission * 0.72) / l7d_clicks or 0
                conservative_roi = l7d_cost > 0 and ((l7d_commission * 0.72 - l7d_cost) / l7d_cost) * 100 or 0
                
                # 生成操作指令
                operation_instruction = self._generate_operation_instruction(
                    l7d_cost, l7d_clicks, l7d_commission, l7d_orders,
                    google_data["is_budget_lost"], google_data["is_rank_lost"],
                    l7d_order_days
                )
                
                analysis_results.append({
                    "begin_date": begin_date.isoformat(),
                    "end_date": end_date.isoformat(),
                    "account_id": account_id,
                    "account_name": account.account_name,
                    "platform_name": account.platform.platform_name,
                    "campaign_count": len(set(c.campaign_id for c in google_data["campaigns"])),
                    "l7d_budget": google_data["total_budget"],
                    "l7d_cost": l7d_cost,
                    "l7d_impressions": l7d_impressions,
                    "l7d_clicks": l7d_clicks,
                    "l7d_cpc": l7d_cpc,
                    "max_cpc_7d": google_data["max_cpc"],
                    "l7d_orders": l7d_orders,
                    "l7d_order_days": l7d_order_days,
                    "l7d_commission": l7d_commission,
                    "conservative_epc": conservative_epc,
                    "conservative_roi": conservative_roi,
                    "is_budget_lost": google_data["is_budget_lost"],
                    "is_rank_lost": google_data["is_rank_lost"],
                    "operation_instruction": operation_instruction,
                })
            
            return {
                "success": True,
                "begin_date": begin_date.isoformat(),
                "end_date": end_date.isoformat(),
                "total_records": len(analysis_results),
                "results": analysis_results
            }
            
        except Exception as e:
            logger.error(f"生成L7D分析失败: {e}")
            return {
                "success": False,
                "message": f"生成分析失败: {str(e)}"
            }
    
    def _find_affiliate_account(
        self,
        platform_code: str,
        account_code: Optional[str],
        user_id: int
    ) -> Optional[AffiliateAccount]:
        """查找对应的联盟账号"""
        query = self.db.query(AffiliateAccount).join(
            AffiliateAccount.platform
        ).filter(
            AffiliateAccount.user_id == user_id,
            AffiliateAccount.platform.has(platform_code=platform_code),
            AffiliateAccount.is_active == True
        )
        
        if account_code:
            query = query.filter(AffiliateAccount.account_code == account_code)
        
        account = query.first()
        
        if account:
            return account
        
        # 如果没找到匹配的账号代码，返回该平台下的第一个账号
        if not account_code:
            account = query.first()
            if account:
                return account
        
        return None
    
    def _generate_operation_instruction(
        self,
        cost: float,
        clicks: float,
        commission: float,
        orders: int,
        is_budget_lost: float,
        is_rank_lost: float,
        order_days: int
    ) -> str:
        """生成操作指令"""
        instructions = []
        
        # 预算丢失判断
        if is_budget_lost > 0.1:  # 超过10%
            instructions.append(f"预算丢失{is_budget_lost*100:.1f}%，建议增加预算")
        
        # Rank丢失判断
        if is_rank_lost > 0.1:  # 超过10%
            instructions.append(f"排名丢失{is_rank_lost*100:.1f}%，建议提高出价")
        
        # ROI判断
        if clicks > 0:
            roi = cost > 0 and ((commission * 0.72 - cost) / cost) * 100 or 0
            if roi < 0:
                instructions.append("ROI为负，建议暂停或优化")
            elif roi < 20:
                instructions.append("ROI较低，建议优化")
        
        # 出单天数判断
        if order_days < 3:
            instructions.append("出单天数较少，建议优化")
        
        if not instructions:
            return "数据正常，保持现状"
        
        return "；".join(instructions)

