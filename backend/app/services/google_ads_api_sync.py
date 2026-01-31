"""
Google Ads API 同步服务
从Google Ads API同步广告数据
"""
from datetime import datetime, date, timedelta
from typing import List, Dict, Optional
from sqlalchemy.orm import Session
import logging

from app.models.google_ads_api_data import GoogleAdsApiData, GoogleMccAccount
from app.services.campaign_matcher import CampaignMatcher

logger = logging.getLogger(__name__)


class GoogleAdsApiSyncService:
    """Google Ads API 同步服务"""
    
    def __init__(self, db: Session):
        self.db = db
        self.matcher = CampaignMatcher(db)
    
    def sync_mcc_data(
        self,
        mcc_id: int,
        target_date: Optional[date] = None
    ) -> Dict:
        """
        同步指定MCC的Google Ads数据
        
        Args:
            mcc_id: MCC账号ID
            target_date: 目标日期，默认为昨天（因为今天的数据可能不完整）
        
        Returns:
            同步结果
        """
        if target_date is None:
            target_date = date.today() - timedelta(days=1)
        
        mcc_account = self.db.query(GoogleMccAccount).filter(
            GoogleMccAccount.id == mcc_id,
            GoogleMccAccount.is_active == True
        ).first()
        
        if not mcc_account:
            return {"success": False, "message": "MCC账号不存在或已停用"}
        
        try:
            # 调用Google Ads API获取数据
            api_data = self._fetch_google_ads_data(
                mcc_account,
                target_date
            )
            
            if not api_data.get("success"):
                logger.error(f"MCC {mcc_account.mcc_id} 同步失败: {api_data.get('message')}")
                return api_data
            
            campaigns_data = api_data.get("campaigns", [])
            
            # 保存数据到数据库
            saved_count = 0
            for campaign_data in campaigns_data:
                try:
                    # 从广告系列名中提取平台信息
                    campaign_name = campaign_data.get("campaign_name", "")
                    platform_info = self.matcher.extract_platform_from_campaign_name(
                        campaign_name,
                        mcc_account.user_id
                    )
                    
                    # 查找或创建记录
                    existing = self.db.query(GoogleAdsApiData).filter(
                        GoogleAdsApiData.mcc_id == mcc_id,
                        GoogleAdsApiData.campaign_id == campaign_data.get("campaign_id"),
                        GoogleAdsApiData.date == target_date
                    ).first()
                    
                    if existing:
                        # 更新现有记录
                        existing.campaign_name = campaign_name
                        existing.budget = campaign_data.get("budget", 0)
                        existing.cost = campaign_data.get("cost", 0)
                        existing.impressions = campaign_data.get("impressions", 0)
                        existing.clicks = campaign_data.get("clicks", 0)
                        existing.cpc = campaign_data.get("cpc", 0)
                        existing.is_budget_lost = campaign_data.get("is_budget_lost", 0)
                        existing.is_rank_lost = campaign_data.get("is_rank_lost", 0)
                        existing.extracted_platform_code = platform_info.get("platform_code") if platform_info else None
                        existing.extracted_account_code = platform_info.get("account_code") if platform_info else None
                        existing.last_sync_at = datetime.now()
                    else:
                        # 创建新记录
                        new_data = GoogleAdsApiData(
                            mcc_id=mcc_id,
                            user_id=mcc_account.user_id,
                            campaign_id=campaign_data.get("campaign_id"),
                            campaign_name=campaign_name,
                            date=target_date,
                            budget=campaign_data.get("budget", 0),
                            cost=campaign_data.get("cost", 0),
                            impressions=campaign_data.get("impressions", 0),
                            clicks=campaign_data.get("clicks", 0),
                            cpc=campaign_data.get("cpc", 0),
                            is_budget_lost=campaign_data.get("is_budget_lost", 0),
                            is_rank_lost=campaign_data.get("is_rank_lost", 0),
                            extracted_platform_code=platform_info.get("platform_code") if platform_info else None,
                            extracted_account_code=platform_info.get("account_code") if platform_info else None
                        )
                        self.db.add(new_data)
                    
                    saved_count += 1
                except Exception as e:
                    logger.error(f"保存Google Ads数据失败: {e}")
                    continue
            
            self.db.commit()
            
            return {
                "success": True,
                "message": f"成功同步 {saved_count} 条广告系列数据",
                "saved_count": saved_count,
                "date": target_date.isoformat()
            }
            
        except Exception as e:
            self.db.rollback()
            logger.error(f"同步Google Ads数据失败: {e}")
            return {"success": False, "message": f"同步失败: {str(e)}"}
    
    def _fetch_google_ads_data(
        self,
        mcc_account: GoogleMccAccount,
        target_date: date
    ) -> Dict:
        """
        从Google Ads API获取数据
        
        Args:
            mcc_account: MCC账号对象
            target_date: 目标日期
        
        Returns:
            API响应数据
        """
        from app.config import settings
        
        # 检查必要的配置
        if not mcc_account.client_id or not mcc_account.client_secret or not mcc_account.refresh_token:
            return {
                "success": False,
                "message": "MCC账号缺少API配置（client_id、client_secret或refresh_token），请在MCC账号编辑页面填写"
            }
        
        if not settings.google_ads_shared_developer_token:
            return {
                "success": False,
                "message": "系统缺少Google Ads开发者令牌（developer_token），请在.env文件中配置GOOGLE_ADS_SHARED_DEVELOPER_TOKEN"
            }
        
        try:
            from google.ads.googleads.client import GoogleAdsClient
            from google.ads.googleads.errors import GoogleAdsException
        except ImportError:
            return {
                "success": False,
                "message": "Google Ads API库未安装，请在服务器上执行: pip install google-ads"
            }
        
        try:
            # 创建Google Ads客户端
            client = GoogleAdsClient.load_from_dict({
                "developer_token": settings.google_ads_shared_developer_token,
                "client_id": mcc_account.client_id,
                "client_secret": mcc_account.client_secret,
                "refresh_token": mcc_account.refresh_token,
                "use_proto_plus": True
            })
            
            # MCC ID需要转换为customer_id格式（去掉横线，只保留数字）
            mcc_customer_id = mcc_account.mcc_id.replace("-", "")
            
            # 先获取MCC下的所有客户账号
            customer_ids = self._get_customer_ids(client, mcc_customer_id)
            
            if not customer_ids:
                logger.warning(f"MCC {mcc_account.mcc_id} 下没有找到客户账号")
                return {
                    "success": True,
                    "campaigns": [],
                    "message": "MCC下没有找到客户账号"
                }
            
            # 对每个客户账号查询广告系列数据
            all_campaigns = []
            date_str = target_date.strftime("%Y-%m-%d")
            
            logger.info(f"开始查询 {len(customer_ids)} 个客户账号的数据，日期: {date_str}")
            
            for customer_id in customer_ids:
                try:
                    logger.info(f"正在查询客户账号 {customer_id}...")
                    query = f"""
                        SELECT
                            campaign.id,
                            campaign.name,
                            campaign_budget.amount_micros,
                            metrics.cost_micros,
                            metrics.impressions,
                            metrics.clicks,
                            metrics.average_cpc,
                            metrics.search_budget_lost_impression_share,
                            metrics.search_rank_lost_impression_share
                        FROM campaign
                        WHERE segments.date = '{date_str}'
                        AND campaign.status != 'REMOVED'
                    """
                    
                    ga_service = client.get_service("GoogleAdsService")
                    response = ga_service.search(customer_id=customer_id, query=query)
                    
                    campaign_count = 0
                    for row in response:
                        budget_micros = row.campaign_budget.amount_micros if row.campaign_budget.amount_micros else 0
                        cost_micros = row.metrics.cost_micros if row.metrics.cost_micros else 0
                        cpc_micros = row.metrics.average_cpc if row.metrics.average_cpc else 0
                        
                        all_campaigns.append({
                            "campaign_id": str(row.campaign.id),
                            "campaign_name": row.campaign.name,
                            "budget": budget_micros / 1_000_000,  # 从微单位转换为标准单位
                            "cost": cost_micros / 1_000_000,
                            "impressions": row.metrics.impressions if row.metrics.impressions else 0,
                            "clicks": row.metrics.clicks if row.metrics.clicks else 0,
                            "cpc": cpc_micros / 1_000_000,
                            "is_budget_lost": row.metrics.search_budget_lost_impression_share if row.metrics.search_budget_lost_impression_share else 0.0,
                            "is_rank_lost": row.metrics.search_rank_lost_impression_share if row.metrics.search_rank_lost_impression_share else 0.0,
                        })
                        campaign_count += 1
                    
                    logger.info(f"客户账号 {customer_id} 查询完成，找到 {campaign_count} 条广告系列")
                        
                except GoogleAdsException as ex:
                    error_code = ex.error.code().name if hasattr(ex.error, 'code') else "UNKNOWN"
                    error_message = ex.error.message if hasattr(ex.error, 'message') else str(ex)
                    logger.error(f"查询客户账号 {customer_id} 失败: {error_code} - {error_message}")
                    # 继续尝试下一个客户账号
                    continue
                except Exception as e:
                    logger.error(f"处理客户账号 {customer_id} 时出错: {e}", exc_info=True)
                    continue
            
            logger.info(f"成功从 {len(customer_ids)} 个客户账号获取 {len(all_campaigns)} 条广告系列数据")
            
            return {
                "success": True,
                "campaigns": all_campaigns
            }
            
        except GoogleAdsException as ex:
            error_msg = f"Google Ads API错误: {ex.error.code().name}"
            if ex.error.message:
                error_msg += f" - {ex.error.message}"
            logger.error(error_msg)
            return {
                "success": False,
                "message": error_msg
            }
        except Exception as e:
            logger.error(f"调用Google Ads API失败: {e}", exc_info=True)
            return {
                "success": False,
                "message": f"API调用失败: {str(e)}"
            }
    
    def _get_customer_ids(self, client, mcc_customer_id: str) -> List[str]:
        """
        获取MCC下的所有客户账号ID
        
        Args:
            client: GoogleAdsClient实例
            mcc_customer_id: MCC的customer_id（去掉横线的数字）
        
        Returns:
            客户账号ID列表
        """
        try:
            # 方法1：使用 CustomerClient 查询获取MCC下的客户列表（推荐方法）
            try:
                logger.info(f"尝试使用CustomerClient查询获取MCC {mcc_customer_id} 下的客户账号...")
                query = """
                    SELECT
                        customer_client.id,
                        customer_client.manager,
                        customer_client.descriptive_name,
                        customer_client.status
                    FROM customer_client
                    WHERE customer_client.manager = FALSE
                    AND customer_client.status = 'ENABLED'
                """
                
                ga_service = client.get_service("GoogleAdsService")
                logger.info(f"执行CustomerClient查询，customer_id={mcc_customer_id}")
                response = ga_service.search(customer_id=mcc_customer_id, query=query)
                logger.info(f"CustomerClient查询完成，开始处理结果...")
                
                customer_ids = []
                for row in response:
                    client_id = str(row.customer_client.id)
                    if client_id != mcc_customer_id:
                        customer_ids.append(client_id)
                        descriptive_name = getattr(row.customer_client, 'descriptive_name', 'N/A')
                        logger.info(f"找到客户账号: {client_id} ({descriptive_name})")
                
                if customer_ids:
                    logger.info(f"通过CustomerClient查询找到 {len(customer_ids)} 个客户账号: {customer_ids}")
                    return customer_ids
                else:
                    logger.warning(f"通过CustomerClient查询没有找到客户账号（MCC下可能没有客户账号或客户账号未启用）")
            except Exception as e:
                logger.warning(f"使用CustomerClient查询失败: {e}")
                import traceback
                logger.debug(traceback.format_exc())
            
            # 方法2：使用 CustomerService.list_accessible_customers() 作为备选
            try:
                customer_service = client.get_service("CustomerService")
                accessible_customers = customer_service.list_accessible_customers()
                
                customer_ids = []
                for resource_name in accessible_customers.resource_names:
                    # resource_name格式: "customers/1234567890"
                    customer_id = resource_name.split("/")[-1]
                    # 排除MCC本身（MCC是管理账号，不能直接查询metrics）
                    if customer_id != mcc_customer_id:
                        customer_ids.append(customer_id)
                
                if customer_ids:
                    logger.info(f"通过CustomerService找到 {len(customer_ids)} 个客户账号: {customer_ids}")
                    return customer_ids
                else:
                    logger.warning(f"通过CustomerService没有找到客户账号（只有MCC本身）")
            except Exception as e:
                logger.warning(f"使用CustomerService获取客户列表失败: {e}")
            
            # 如果两种方法都失败，返回空列表（而不是MCC ID本身）
            logger.error(f"无法获取MCC {mcc_customer_id} 下的客户账号列表。可能的原因：1) MCC下没有客户账号 2) 客户账号未启用 3) API权限不足")
            return []
            
        except Exception as e:
            logger.error(f"获取客户账号列表失败: {e}", exc_info=True)
            return []
    
    def sync_all_active_mccs(self, target_date: Optional[date] = None) -> Dict:
        """
        同步所有活跃的MCC账号数据
        
        Args:
            target_date: 目标日期，默认为昨天
        
        Returns:
            同步结果汇总
        """
        if target_date is None:
            target_date = date.today() - timedelta(days=1)
        
        active_mccs = self.db.query(GoogleMccAccount).filter(
            GoogleMccAccount.is_active == True
        ).all()
        
        results = []
        total_saved = 0
        
        for mcc in active_mccs:
            result = self.sync_mcc_data(mcc.id, target_date)
            results.append({
                "mcc_id": mcc.id,
                "mcc_name": mcc.mcc_name,
                "result": result
            })
            if result.get("success"):
                total_saved += result.get("saved_count", 0)
        
        return {
            "success": True,
            "message": f"同步完成，共处理 {len(active_mccs)} 个MCC账号",
            "total_saved": total_saved,
            "results": results
        }


