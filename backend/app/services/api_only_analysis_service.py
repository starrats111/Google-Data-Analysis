"""
纯API数据分析服务
完全基于API数据生成分析结果，输出格式符合表6要求
去除所有手动上传功能
"""
from datetime import date, timedelta
from typing import Dict, List, Optional
from sqlalchemy.orm import Session
from sqlalchemy import func, and_, or_
import logging

from app.models.platform_data import PlatformData
from app.models.google_ads_api_data import GoogleAdsApiData
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.analysis_result import AnalysisResult
from app.models.keyword_bid import CampaignBidStrategy

logger = logging.getLogger(__name__)


class ApiOnlyAnalysisService:
    """纯API数据分析服务 - 只从API数据生成分析结果"""
    
    def __init__(self, db: Session):
        self.db = db
    
    def generate_analysis_from_api(
        self,
        begin_date: date,
        end_date: date,
        user_id: Optional[int] = None,
        account_id: Optional[int] = None,
        platform_id: Optional[int] = None,
        analysis_type: str = "l7d"
    ) -> Dict:
        """
        从API数据生成分析结果（符合表6格式）
        
        Args:
            begin_date: 开始日期
            end_date: 结束日期
            user_id: 用户ID（可选）
            account_id: 账号ID（可选）
            platform_id: 平台ID（可选）
            analysis_type: 分析类型 'daily' 或 'l7d'
        
        Returns:
            分析结果字典，包含符合表6格式的数据
        """
        try:
            # 1. 获取Google Ads数据
            google_ads_query = self.db.query(GoogleAdsApiData).filter(
                GoogleAdsApiData.date >= begin_date,
                GoogleAdsApiData.date <= end_date
            )
            
            if user_id:
                google_ads_query = google_ads_query.filter(
                    GoogleAdsApiData.user_id == user_id
                )
            
            # 如果指定了平台ID，需要先找到对应的平台代码
            platform_code_filter = None
            if platform_id:
                platform = self.db.query(AffiliatePlatform).filter(
                    AffiliatePlatform.id == platform_id
                ).first()
                if platform:
                    platform_code_filter = platform.platform_code
            
            if platform_code_filter:
                google_ads_query = google_ads_query.filter(
                    GoogleAdsApiData.extracted_platform_code == platform_code_filter
                )
            
            google_ads_data = google_ads_query.all()
            
            if not google_ads_data:
                return {
                    "success": False,
                    "message": "未找到Google Ads数据"
                }
            
            # 2. 按广告系列分组聚合Google Ads数据
            campaigns_data = {}
            for data in google_ads_data:
                campaign_id = data.campaign_id
                campaign_name = data.campaign_name
                
                if campaign_id not in campaigns_data:
                    campaigns_data[campaign_id] = {
                        "campaign_id": campaign_id,
                        "campaign_name": campaign_name,
                        "platform_code": data.extracted_platform_code,
                        "merchant_id": data.extracted_account_code,
                        "status": data.status or "未知",
                        "dates": set(),
                        "total_budget": 0,
                        "total_cost": 0,
                        "total_impressions": 0,
                        "total_clicks": 0,
                        "max_cpc": 0,
                        "is_budget_lost": 0,
                        "is_rank_lost": 0,
                        "user_id": data.user_id,
                    }
                
                campaigns_data[campaign_id]["dates"].add(data.date)
                campaigns_data[campaign_id]["total_budget"] += data.budget or 0
                campaigns_data[campaign_id]["total_cost"] += data.cost or 0
                campaigns_data[campaign_id]["total_impressions"] += data.impressions or 0
                campaigns_data[campaign_id]["total_clicks"] += data.clicks or 0
                campaigns_data[campaign_id]["max_cpc"] = max(
                    campaigns_data[campaign_id]["max_cpc"],
                    data.cpc or 0
                )
                campaigns_data[campaign_id]["is_budget_lost"] = max(
                    campaigns_data[campaign_id]["is_budget_lost"],
                    data.is_budget_lost or 0
                )
                campaigns_data[campaign_id]["is_rank_lost"] = max(
                    campaigns_data[campaign_id]["is_rank_lost"],
                    data.is_rank_lost or 0
                )
            
            # 3. 获取平台数据
            platform_data_query = self.db.query(PlatformData).filter(
                PlatformData.date >= begin_date,
                PlatformData.date <= end_date
            )
            
            if user_id:
                platform_data_query = platform_data_query.filter(
                    PlatformData.user_id == user_id
                )
            
            if account_id:
                platform_data_query = platform_data_query.filter(
                    PlatformData.affiliate_account_id == account_id
                )
            
            if platform_id:
                platform_data_query = platform_data_query.join(
                    AffiliateAccount
                ).filter(
                    AffiliateAccount.platform_id == platform_id
                )
            
            platform_data_list = platform_data_query.all()
            
            # 4. 按账号和日期聚合平台数据
            platform_by_account_date = {}
            for pd in platform_data_list:
                key = (pd.affiliate_account_id, pd.date)
                if key not in platform_by_account_date:
                    platform_by_account_date[key] = {
                        "commission": 0,
                        "orders": 0,
                    }
                platform_by_account_date[key]["commission"] += pd.commission or 0
                platform_by_account_date[key]["orders"] += pd.orders or 0
            
            # 5. 匹配Google Ads数据和平台数据，生成分析结果
            analysis_results = []
            
            for campaign_id, campaign_data in campaigns_data.items():
                # 查找对应的联盟账号
                affiliate_account = self._find_affiliate_account(
                    campaign_data["platform_code"],
                    campaign_data["merchant_id"],
                    campaign_data["user_id"],
                    account_id=account_id  # 如果指定了账号ID，只查找该账号
                )
                
                if not affiliate_account:
                    continue
                
                # 如果指定了账号ID，确保匹配
                if account_id and affiliate_account.id != account_id:
                    continue
                
                # 如果指定了平台ID，确保匹配
                if platform_id and affiliate_account.platform_id != platform_id:
                    continue
                
                # 计算该广告系列对应账号在日期范围内的平台数据
                total_commission = 0
                total_orders = 0
                order_days = set()
                
                for pd in platform_data_list:
                    if pd.affiliate_account_id == affiliate_account.id:
                        if pd.date in campaign_data["dates"]:
                            total_commission += pd.commission or 0
                            total_orders += pd.orders or 0
                            if pd.orders and pd.orders > 0:
                                order_days.add(pd.date)
                
                # 计算指标
                cost = campaign_data["total_cost"]
                clicks = campaign_data["total_clicks"]
                impressions = campaign_data["total_impressions"]
                cpc = clicks > 0 and cost / clicks or 0
                commission = total_commission
                orders = total_orders
                order_days_count = len(order_days)
                
                # 过滤掉没有数据的广告系列（点击=0 且 花费=0 且 佣金=0）
                if clicks == 0 and cost == 0 and commission == 0:
                    continue
                
                # 计算保守指标
                conservative_commission = commission * 0.72
                conservative_epc = clicks > 0 and conservative_commission / clicks or 0
                conservative_roi = cost > 0 and ((conservative_commission - cost) / cost) or None
                
                # 当前Max CPC：从 CampaignBidStrategy 获取人工出价上限
                bid_strategy = self.db.query(CampaignBidStrategy).filter(
                    CampaignBidStrategy.user_id == user_id,
                    CampaignBidStrategy.campaign_name == campaign_data["campaign_name"]
                ).first()
                max_cpc_limit = bid_strategy.max_cpc_limit if bid_strategy and bid_strategy.max_cpc_limit else None
                # 如果没有人工出价上限，回退到过去7天CPC最大值
                current_max_cpc = max_cpc_limit if max_cpc_limit else campaign_data["max_cpc"]
                
                # 生成操作指令（带具体数值）
                budget = campaign_data["total_budget"]
                operation_instruction = self._generate_operation_instruction(
                    cost, clicks, commission, orders,
                    campaign_data["is_budget_lost"], campaign_data["is_rank_lost"],
                    order_days_count, cpc, budget, conservative_roi
                )
                
                # 构建符合表6格式的分析结果
                result_row = {
                    # 基础信息
                    "日期": end_date.isoformat() if analysis_type == "daily" else f"{begin_date.isoformat()}~{end_date.isoformat()}",
                    "广告系列名": campaign_data["campaign_name"],
                    "MID": campaign_data["merchant_id"],
                    "平台": affiliate_account.platform.platform_name if affiliate_account.platform else None,
                    "账号": affiliate_account.account_name,
                    "账号ID": affiliate_account.id,  # 用于筛选
                    
                    # Google Ads指标
                    "预算": round(campaign_data["total_budget"], 2),
                    "费用": round(cost, 2),
                    "展示": int(impressions),
                    "点击": int(clicks),
                    "CPC": round(cpc, 4),
                    "最高CPC": round(campaign_data["max_cpc"], 4),
                    "IS Budget丢失": round(campaign_data["is_budget_lost"] * 100, 2) if campaign_data["is_budget_lost"] else None,
                    "IS Rank丢失": round(campaign_data["is_rank_lost"] * 100, 2) if campaign_data["is_rank_lost"] else None,
                    "谷歌状态": campaign_data["status"],
                    
                    # 平台数据指标
                    "订单数": int(orders),
                    "佣金": round(commission, 2),
                    "出单天数": order_days_count,
                    
                    # 计算指标
                    "保守佣金": round(conservative_commission, 2),
                    "保守EPC": round(conservative_epc, 4),
                    "保守ROI": round(conservative_roi * 100, 2) if conservative_roi is not None else None,
                    
                    # L7D指标（如果是L7D分析）
                    "L7D点击": int(clicks) if analysis_type == "l7d" else None,
                    "L7D佣金": round(commission, 2) if analysis_type == "l7d" else None,
                    "L7D花费": round(cost, 2) if analysis_type == "l7d" else None,
                    "L7D出单天数": order_days_count if analysis_type == "l7d" else None,
                    
                    # 其他
                    "当前Max CPC": round(current_max_cpc, 4),
                    "操作指令": operation_instruction,
                    "异常类型": None,  # 需要额外逻辑检测
                }
                
                analysis_results.append(result_row)
            
            # 6. 保存到数据库（可选 - 根据需求决定是否保存）
            # 如果需要保存，可以在这里添加保存逻辑
            # 目前先不保存，直接返回结果
            
            return {
                "success": True,
                "begin_date": begin_date.isoformat(),
                "end_date": end_date.isoformat(),
                "analysis_type": analysis_type,
                "total_records": len(analysis_results),
                "data": analysis_results
            }
            
        except Exception as e:
            logger.error(f"生成分析失败: {e}", exc_info=True)
            self.db.rollback()
            return {
                "success": False,
                "message": f"生成分析失败: {str(e)}"
            }
    
    def _find_affiliate_account(
        self,
        platform_code: Optional[str],
        merchant_id: Optional[str],
        user_id: int,
        account_id: Optional[int] = None
    ) -> Optional[AffiliateAccount]:
        """查找对应的联盟账号 - 使用platform_name匹配（如PM、LH、CG等）"""
        if not platform_code:
            return None
        
        # 如果指定了账号ID，直接查找
        if account_id:
            account = self.db.query(AffiliateAccount).filter(
                AffiliateAccount.id == account_id,
                AffiliateAccount.user_id == user_id,
                AffiliateAccount.is_active == True
            ).first()
            if account:
                # 验证平台名称是否匹配（用platform_name而不是platform_code）
                if account.platform and account.platform.platform_name == platform_code.upper():
                    return account
            return None
        
        # 按平台名称查找（platform_name = "PM"/"LH" 等，而不是platform_code = URL）
        query = self.db.query(AffiliateAccount).join(
            AffiliatePlatform
        ).filter(
            AffiliateAccount.user_id == user_id,
            AffiliatePlatform.platform_name == platform_code.upper(),
            AffiliateAccount.is_active == True
        )
        
        if merchant_id:
            query = query.filter(AffiliateAccount.account_code == merchant_id)
        
        account = query.first()
        
        if account:
            return account
        
        # 如果没找到匹配的账号代码，返回该平台下的第一个账号
        base_query = self.db.query(AffiliateAccount).join(
            AffiliatePlatform
        ).filter(
            AffiliateAccount.user_id == user_id,
            AffiliatePlatform.platform_name == platform_code.upper(),
            AffiliateAccount.is_active == True
        )
        return base_query.first()
    
    def _generate_operation_instruction(
        self,
        cost: float,
        clicks: float,
        commission: float,
        orders: int,
        is_budget_lost: float,
        is_rank_lost: float,
        order_days: int,
        cpc: float = 0,
        budget: float = 0,
        conservative_roi: float = None
    ) -> str:
        """
        生成操作指令（简洁格式）
        格式: CPC $X.XX→$X.XX | 预算 $X.XX→$X.XX(+X%)
        """
        
        # 计算 ROI（如果没传入）
        if conservative_roi is None:
            conservative_roi = cost > 0 and ((commission * 0.72 - cost) / cost) or 0
        
        # ROI 严重为负，关停
        if conservative_roi < -0.4:
            return "关停"
        
        instructions = []
        
        # ROI 为负，降价
        if conservative_roi < 0:
            if cpc > 0:
                new_cpc = max(0.01, cpc - 0.05)
                instructions.append(f"CPC ${cpc:.2f}→${new_cpc:.2f}")
            else:
                instructions.append("降CPC")
        
        # ROI 优秀且有预算瓶颈，加预算
        elif conservative_roi > 1.5 and is_budget_lost and is_budget_lost > 0.2 and order_days >= 4:
            if budget > 0:
                new_budget = budget * 1.3
                pct = 30
                instructions.append(f"预算 ${budget:.2f}→${new_budget:.2f}(+{pct}%)")
            else:
                instructions.append("加预算")
            # 同时可能需要提高CPC抢占排名
            if is_rank_lost and is_rank_lost > 0.15 and cpc > 0:
                new_cpc = cpc + 0.02
                instructions.append(f"CPC ${cpc:.2f}→${new_cpc:.2f}")
        
        # ROI 良好且有排名瓶颈，提高CPC
        elif conservative_roi > 1.0 and is_rank_lost and is_rank_lost > 0.15:
            if cpc > 0:
                new_cpc = cpc + 0.02
                instructions.append(f"CPC ${cpc:.2f}→${new_cpc:.2f}")
            else:
                instructions.append("提高CPC")
        
        # ROI 中等，有预算瓶颈，考虑加预算
        elif conservative_roi >= 0.8 and is_budget_lost and is_budget_lost > 0.3:
            if budget > 0:
                new_budget = budget * 1.2
                pct = 20
                instructions.append(f"预算 ${budget:.2f}→${new_budget:.2f}(+{pct}%)")
        
        # ROI 正常，维持
        elif conservative_roi >= 0.5:
            return "维持"
        
        # 样本不足
        else:
            return "样本不足"
        
        # 组合指令
        if instructions:
            return " | ".join(instructions)
        return "维持"

