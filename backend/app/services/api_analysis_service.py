"""
基于API数据的分析服务（简化版）
直接从Google Ads数据生成每日分析，保存到数据库
"""
from datetime import date, timedelta
from typing import Dict, Optional
from sqlalchemy.orm import Session
from sqlalchemy import func
import logging

from app.models.google_ads_api_data import GoogleAdsApiData
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.analysis_result import AnalysisResult

logger = logging.getLogger(__name__)


class ApiAnalysisService:
    """基于API数据的分析服务"""
    
    def __init__(self, db: Session):
        self.db = db
    
    def generate_daily_analysis(
        self,
        target_date: date,
        user_id: Optional[int] = None
    ) -> Dict:
        """
        生成指定日期的每日分析
        
        简化逻辑：
        1. 查询当天的Google Ads数据
        2. 按联盟账号分组
        3. 生成分析记录并保存
        """
        logger.info(f"=== 开始生成每日分析 === 日期: {target_date}, 用户ID: {user_id}")
        
        try:
            # 1. 查询Google Ads数据
            query = self.db.query(GoogleAdsApiData).filter(
                GoogleAdsApiData.date == target_date
            )
            
            if user_id:
                query = query.filter(GoogleAdsApiData.user_id == user_id)
            
            google_ads_data = query.all()
            logger.info(f"找到 {len(google_ads_data)} 条Google Ads数据")
            
            if not google_ads_data:
                return {
                    "success": True,
                    "date": target_date.isoformat(),
                    "total_records": 0,
                    "message": "没有找到Google Ads数据"
                }
            
            # 2. 按平台分组聚合数据
            platform_data = {}
            for data in google_ads_data:
                platform_code = data.extracted_platform_code
                if not platform_code:
                    logger.debug(f"广告系列 {data.campaign_name} 没有平台代码，跳过")
                    continue
                
                data_user_id = data.user_id
                key = (platform_code, data_user_id)
                
                if key not in platform_data:
                    platform_data[key] = {
                        "platform_code": platform_code,
                        "user_id": data_user_id,
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
            
            logger.info(f"按平台分组后有 {len(platform_data)} 组数据")
            
            # 3. 为每组数据匹配联盟账号并生成分析
            created_count = 0
            skipped_count = 0
            
            for key, pdata in platform_data.items():
                platform_code = pdata["platform_code"]
                data_user_id = pdata["user_id"]
                
                # 查找联盟账号（用platform_name匹配，如PM、LH、CG）
                affiliate_account = self.db.query(AffiliateAccount).join(
                    AffiliatePlatform
                ).filter(
                    AffiliateAccount.user_id == data_user_id,
                    AffiliatePlatform.platform_name == platform_code,
                    AffiliateAccount.is_active == True
                ).first()
                
                if not affiliate_account:
                    logger.warning(f"用户 {data_user_id} 的平台 {platform_code} 没有找到联盟账号")
                    skipped_count += 1
                    continue
                
                logger.info(f"平台 {platform_code} 匹配到联盟账号: {affiliate_account.account_name}")
                
                # 检查是否已存在
                existing = self.db.query(AnalysisResult).filter(
                    AnalysisResult.user_id == data_user_id,
                    AnalysisResult.affiliate_account_id == affiliate_account.id,
                    AnalysisResult.analysis_date == target_date,
                    AnalysisResult.analysis_type == "daily"
                ).first()
                
                if existing:
                    logger.info(f"分析记录已存在，跳过: 用户{data_user_id} 账号{affiliate_account.id}")
                    skipped_count += 1
                    continue
                
                # 计算指标
                cost = pdata["total_cost"]
                clicks = pdata["total_clicks"]
                impressions = pdata["total_impressions"]
                cpc = (cost / clicks) if clicks > 0 else 0
                
                # 保守佣金相关（没有平台数据时默认为0）
                conservative_epc = 0
                conservative_roi = 0
                
                # 生成操作指令
                instructions = []
                if pdata["is_budget_lost"] > 0.1:
                    instructions.append(f"预算丢失{pdata['is_budget_lost']*100:.1f}%")
                if pdata["is_rank_lost"] > 0.1:
                    instructions.append(f"排名丢失{pdata['is_rank_lost']*100:.1f}%")
                operation = "；".join(instructions) if instructions else "正常"
                
                # 创建分析结果
                result_data = {
                    "data": [{
                        "date": target_date.isoformat(),
                        "platform": platform_code,
                        "account_name": affiliate_account.account_name,
                        "campaign_count": len(pdata["campaigns"]),
                        "cost": round(cost, 2),
                        "clicks": clicks,
                        "impressions": impressions,
                        "cpc": round(cpc, 4),
                        "max_cpc": round(pdata["max_cpc"], 4),
                        "budget": round(pdata["total_budget"], 2),
                        "is_budget_lost": round(pdata["is_budget_lost"] * 100, 2),
                        "is_rank_lost": round(pdata["is_rank_lost"] * 100, 2),
                        "operation": operation,
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
                created_count += 1
                logger.info(f"创建分析记录: 用户{data_user_id} 账号{affiliate_account.account_name} 费用${cost:.2f}")
            
            # 提交数据库
            self.db.commit()
            
            logger.info(f"=== 每日分析完成 === 创建: {created_count}, 跳过: {skipped_count}")
            
            return {
                "success": True,
                "date": target_date.isoformat(),
                "total_records": created_count,
                "skipped_records": skipped_count,
                "message": f"成功创建 {created_count} 条分析记录"
            }
            
        except Exception as e:
            logger.error(f"生成每日分析失败: {e}", exc_info=True)
            self.db.rollback()
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
        """
        logger.info(f"=== 开始生成L7D分析 === 结束日期: {end_date}, 用户ID: {user_id}")
        
        try:
            begin_date = end_date - timedelta(days=6)
            
            # 查询过去7天的Google Ads数据
            query = self.db.query(GoogleAdsApiData).filter(
                GoogleAdsApiData.date >= begin_date,
                GoogleAdsApiData.date <= end_date
            )
            
            if user_id:
                query = query.filter(GoogleAdsApiData.user_id == user_id)
            
            google_ads_data = query.all()
            logger.info(f"找到 {len(google_ads_data)} 条Google Ads数据 ({begin_date} ~ {end_date})")
            
            if not google_ads_data:
                return {
                    "success": True,
                    "begin_date": begin_date.isoformat(),
                    "end_date": end_date.isoformat(),
                    "total_records": 0,
                    "message": "没有找到Google Ads数据"
                }
            
            # 按平台和用户分组
            platform_data = {}
            for data in google_ads_data:
                platform_code = data.extracted_platform_code
                if not platform_code:
                    continue
                
                data_user_id = data.user_id
                key = (platform_code, data_user_id)
                
                if key not in platform_data:
                    platform_data[key] = {
                        "platform_code": platform_code,
                        "user_id": data_user_id,
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
            
            logger.info(f"按平台分组后有 {len(platform_data)} 组数据")
            
            # 生成L7D分析
            results = []
            
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
                    logger.warning(f"用户 {data_user_id} 的平台 {platform_code} 没有找到联盟账号")
                    continue
                
                cost = pdata["total_cost"]
                clicks = pdata["total_clicks"]
                cpc = (cost / clicks) if clicks > 0 else 0
                
                results.append({
                    "begin_date": begin_date.isoformat(),
                    "end_date": end_date.isoformat(),
                    "platform": platform_code,
                    "account_name": affiliate_account.account_name,
                    "campaign_count": len(pdata["campaigns"]),
                    "days_with_data": len(pdata["dates"]),
                    "l7d_cost": round(cost, 2),
                    "l7d_clicks": clicks,
                    "l7d_impressions": pdata["total_impressions"],
                    "l7d_cpc": round(cpc, 4),
                    "max_cpc": round(pdata["max_cpc"], 4),
                    "is_budget_lost": round(pdata["is_budget_lost"] * 100, 2),
                    "is_rank_lost": round(pdata["is_rank_lost"] * 100, 2),
                })
            
            logger.info(f"=== L7D分析完成 === 生成: {len(results)} 条")
            
            return {
                "success": True,
                "begin_date": begin_date.isoformat(),
                "end_date": end_date.isoformat(),
                "total_records": len(results),
                "results": results
            }
            
        except Exception as e:
            logger.error(f"生成L7D分析失败: {e}", exc_info=True)
            return {
                "success": False,
                "message": f"生成分析失败: {str(e)}"
            }
