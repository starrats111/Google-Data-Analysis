"""
基于API数据的分析服务
支持日期范围，生成每日分析记录
"""
from datetime import date, timedelta
from typing import Dict, Optional, List
from sqlalchemy.orm import Session
from sqlalchemy import func
import logging

from app.models.google_ads_api_data import GoogleAdsApiData
from app.models.platform_data import PlatformData
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.analysis_result import AnalysisResult

logger = logging.getLogger(__name__)


class ApiAnalysisService:
    """基于API数据的分析服务"""
    
    def __init__(self, db: Session):
        self.db = db
    
    def generate_daily_analysis(
        self,
        begin_date: date,
        end_date: date,
        user_id: Optional[int] = None
    ) -> Dict:
        """
        生成日期范围内每一天的分析
        
        Args:
            begin_date: 开始日期
            end_date: 结束日期
            user_id: 用户ID
        """
        logger.info(f"=== 开始生成每日分析 === 范围: {begin_date} ~ {end_date}, 用户ID: {user_id}")
        
        total_created = 0
        total_skipped = 0
        errors = []
        
        # 遍历日期范围内的每一天
        current_date = begin_date
        while current_date <= end_date:
            try:
                result = self._generate_single_day_analysis(current_date, user_id)
                total_created += result.get("created", 0)
                total_skipped += result.get("skipped", 0)
                if result.get("error"):
                    errors.append(f"{current_date}: {result['error']}")
            except Exception as e:
                logger.error(f"处理 {current_date} 失败: {e}")
                errors.append(f"{current_date}: {str(e)}")
            
            current_date += timedelta(days=1)
        
        # 提交所有更改
        try:
            self.db.commit()
        except Exception as e:
            logger.error(f"提交数据库失败: {e}")
            self.db.rollback()
            return {"success": False, "message": f"保存失败: {str(e)}"}
        
        logger.info(f"=== 每日分析完成 === 创建: {total_created}, 跳过: {total_skipped}")
        
        return {
            "success": True,
            "begin_date": begin_date.isoformat(),
            "end_date": end_date.isoformat(),
            "total_records": total_created,
            "skipped_records": total_skipped,
            "errors": errors if errors else None
        }
    
    def _generate_single_day_analysis(
        self,
        target_date: date,
        user_id: Optional[int] = None
    ) -> Dict:
        """生成单天的分析"""
        
        # 1. 查询Google Ads数据
        query = self.db.query(GoogleAdsApiData).filter(
            GoogleAdsApiData.date == target_date
        )
        if user_id:
            query = query.filter(GoogleAdsApiData.user_id == user_id)
        
        google_ads_data = query.all()
        
        if not google_ads_data:
            return {"created": 0, "skipped": 0}
        
        # 2. 按平台和用户分组
        platform_data = {}
        for data in google_ads_data:
            platform_code = data.extracted_platform_code
            if not platform_code:
                continue
            
            key = (platform_code, data.user_id)
            if key not in platform_data:
                platform_data[key] = {
                    "platform_code": platform_code,
                    "user_id": data.user_id,
                    "campaigns": [],
                    "total_cost": 0.0,
                    "total_clicks": 0,
                    "total_impressions": 0,
                    "total_budget": 0.0,
                    "max_cpc": 0.0,
                    "is_budget_lost": 0.0,
                    "is_rank_lost": 0.0,
                }
            
            platform_data[key]["campaigns"].append(data.campaign_name)
            platform_data[key]["total_cost"] += (data.cost or 0)
            platform_data[key]["total_clicks"] += int(data.clicks or 0)
            platform_data[key]["total_impressions"] += int(data.impressions or 0)
            platform_data[key]["total_budget"] += (data.budget or 0)
            platform_data[key]["max_cpc"] = max(platform_data[key]["max_cpc"], (data.cpc or 0))
            platform_data[key]["is_budget_lost"] = max(platform_data[key]["is_budget_lost"], (data.is_budget_lost or 0))
            platform_data[key]["is_rank_lost"] = max(platform_data[key]["is_rank_lost"], (data.is_rank_lost or 0))
        
        # 3. 匹配联盟账号并生成分析
        created = 0
        skipped = 0
        
        for key, pdata in platform_data.items():
            platform_code = pdata["platform_code"]
            data_user_id = pdata["user_id"]
            
            # 查找联盟账号
            affiliate_account = self.db.query(AffiliateAccount).join(
                AffiliatePlatform
            ).filter(
                AffiliateAccount.user_id == data_user_id,
                AffiliatePlatform.platform_name == platform_code,
                AffiliateAccount.is_active == True
            ).first()
            
            if not affiliate_account:
                logger.debug(f"用户 {data_user_id} 的平台 {platform_code} 没有找到联盟账号")
                skipped += 1
                continue
            
            # 检查是否已存在
            existing = self.db.query(AnalysisResult).filter(
                AnalysisResult.user_id == data_user_id,
                AnalysisResult.affiliate_account_id == affiliate_account.id,
                AnalysisResult.analysis_date == target_date,
                AnalysisResult.analysis_type == "daily"
            ).first()
            
            if existing:
                skipped += 1
                continue
            
            # 获取平台数据（佣金、订单）
            platform_record = self.db.query(PlatformData).filter(
                PlatformData.affiliate_account_id == affiliate_account.id,
                PlatformData.date == target_date
            ).first()
            
            commission = platform_record.commission if platform_record else 0
            orders = platform_record.orders if platform_record else 0
            
            # 计算指标
            cost = pdata["total_cost"]
            clicks = pdata["total_clicks"]
            impressions = pdata["total_impressions"]
            budget = pdata["total_budget"]
            cpc = (cost / clicks) if clicks > 0 else 0
            
            # 保守佣金 = 佣金 * 0.72
            conservative_commission = commission * 0.72
            # 保守ROI = (保守佣金 - 费用) / 费用 * 100
            roi = ((conservative_commission - cost) / cost * 100) if cost > 0 else 0
            
            # 生成操作指令
            operation = self._generate_operation_instruction(
                pdata["is_budget_lost"],
                pdata["is_rank_lost"],
                roi,
                orders
            )
            
            # 构建完整数据
            result_data = {
                "data": [{
                    "日期": target_date.isoformat(),
                    "平台": platform_code,
                    "账号": affiliate_account.account_name,
                    "广告系列数": len(pdata["campaigns"]),
                    "预算": round(budget, 2),
                    "费用": round(cost, 2),
                    "展示": impressions,
                    "点击": clicks,
                    "CPC": round(cpc, 4),
                    "IS Budget丢失": f"{pdata['is_budget_lost'] * 100:.1f}%" if pdata['is_budget_lost'] > 0 else "-",
                    "IS Rank丢失": f"{pdata['is_rank_lost'] * 100:.1f}%" if pdata['is_rank_lost'] > 0 else "-",
                    "佣金": round(commission, 2),
                    "订单数": orders,
                    "保守ROI": f"{roi:.1f}%" if cost > 0 else "-",
                    "操作指令": operation,
                }]
            }
            
            analysis_result = AnalysisResult(
                user_id=data_user_id,
                affiliate_account_id=affiliate_account.id,
                analysis_date=target_date,
                analysis_type="daily",
                result_data=result_data
            )
            self.db.add(analysis_result)
            created += 1
        
        return {"created": created, "skipped": skipped}
    
    def _generate_operation_instruction(
        self,
        is_budget_lost: float,
        is_rank_lost: float,
        roi: float,
        orders: int
    ) -> str:
        """生成操作指令"""
        instructions = []
        
        if is_budget_lost > 0.1:
            instructions.append(f"预算丢失{is_budget_lost*100:.0f}%，增加预算")
        
        if is_rank_lost > 0.1:
            instructions.append(f"排名丢失{is_rank_lost*100:.0f}%，提高出价")
        
        if roi < 0:
            instructions.append("ROI为负，建议暂停")
        elif roi < 20:
            instructions.append("ROI较低，优化广告")
        
        if orders == 0:
            instructions.append("无订单，检查转化")
        
        return "；".join(instructions) if instructions else "正常运行"
    
    def generate_l7d_analysis(
        self,
        end_date: date,
        user_id: Optional[int] = None
    ) -> Dict:
        """生成L7D分析"""
        begin_date = end_date - timedelta(days=6)
        logger.info(f"=== 开始生成L7D分析 === 范围: {begin_date} ~ {end_date}")
        
        try:
            query = self.db.query(GoogleAdsApiData).filter(
                GoogleAdsApiData.date >= begin_date,
                GoogleAdsApiData.date <= end_date
            )
            if user_id:
                query = query.filter(GoogleAdsApiData.user_id == user_id)
            
            google_ads_data = query.all()
            
            if not google_ads_data:
                return {"success": True, "total_records": 0, "message": "没有数据"}
            
            # 按平台分组
            platform_data = {}
            for data in google_ads_data:
                if not data.extracted_platform_code:
                    continue
                key = (data.extracted_platform_code, data.user_id)
                if key not in platform_data:
                    platform_data[key] = {
                        "platform_code": data.extracted_platform_code,
                        "user_id": data.user_id,
                        "dates": set(),
                        "campaigns": set(),
                        "total_cost": 0.0,
                        "total_clicks": 0,
                        "total_impressions": 0,
                        "max_cpc": 0.0,
                        "is_budget_lost": 0.0,
                        "is_rank_lost": 0.0,
                    }
                platform_data[key]["dates"].add(data.date)
                platform_data[key]["campaigns"].add(data.campaign_name)
                platform_data[key]["total_cost"] += (data.cost or 0)
                platform_data[key]["total_clicks"] += int(data.clicks or 0)
                platform_data[key]["total_impressions"] += int(data.impressions or 0)
                platform_data[key]["max_cpc"] = max(platform_data[key]["max_cpc"], (data.cpc or 0))
                platform_data[key]["is_budget_lost"] = max(platform_data[key]["is_budget_lost"], (data.is_budget_lost or 0))
                platform_data[key]["is_rank_lost"] = max(platform_data[key]["is_rank_lost"], (data.is_rank_lost or 0))
            
            results = []
            for key, pdata in platform_data.items():
                affiliate_account = self.db.query(AffiliateAccount).join(
                    AffiliatePlatform
                ).filter(
                    AffiliateAccount.user_id == pdata["user_id"],
                    AffiliatePlatform.platform_name == pdata["platform_code"],
                    AffiliateAccount.is_active == True
                ).first()
                
                if not affiliate_account:
                    continue
                
                cost = pdata["total_cost"]
                clicks = pdata["total_clicks"]
                cpc = (cost / clicks) if clicks > 0 else 0
                
                results.append({
                    "平台": pdata["platform_code"],
                    "账号": affiliate_account.account_name,
                    "数据天数": len(pdata["dates"]),
                    "广告系列数": len(pdata["campaigns"]),
                    "L7D费用": round(cost, 2),
                    "L7D点击": clicks,
                    "L7D展示": pdata["total_impressions"],
                    "平均CPC": round(cpc, 4),
                    "最高CPC": round(pdata["max_cpc"], 4),
                    "IS Budget丢失": f"{pdata['is_budget_lost'] * 100:.1f}%",
                    "IS Rank丢失": f"{pdata['is_rank_lost'] * 100:.1f}%",
                })
            
            return {
                "success": True,
                "begin_date": begin_date.isoformat(),
                "end_date": end_date.isoformat(),
                "total_records": len(results),
                "results": results
            }
            
        except Exception as e:
            logger.error(f"L7D分析失败: {e}", exc_info=True)
            return {"success": False, "message": str(e)}
