"""
Google Ads API 同步服务
从Google Ads API同步广告数据
"""
from datetime import datetime, date, timedelta
from typing import List, Dict, Optional
from sqlalchemy.orm import Session
import logging
import time

from app.models.google_ads_api_data import GoogleAdsApiData, GoogleMccAccount
from app.models.ad_campaign import AdCampaign
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
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
        target_date: Optional[date] = None,
        force_refresh: bool = False
    ) -> Dict:
        """
        同步指定MCC的Google Ads数据（增量同步）
        
        Args:
            mcc_id: MCC账号ID
            target_date: 目标日期，默认为昨天（因为今天的数据可能不完整）
            force_refresh: 是否强制刷新（即使数据已存在也重新同步）
        
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
        
        # 增量同步检查：如果数据已存在且不是强制刷新，检查是否需要同步
        if not force_refresh:
            existing_count = self.db.query(GoogleAdsApiData).filter(
                GoogleAdsApiData.mcc_id == mcc_id,
                GoogleAdsApiData.date == target_date
            ).count()
            
            if existing_count > 0:
                # 检查数据是否是最新的（今天同步的）
                latest_sync = self.db.query(GoogleAdsApiData).filter(
                    GoogleAdsApiData.mcc_id == mcc_id,
                    GoogleAdsApiData.date == target_date
                ).order_by(GoogleAdsApiData.last_sync_at.desc()).first()
                
                if latest_sync and latest_sync.last_sync_at:
                    # 如果数据是今天同步的，跳过API调用
                    sync_date = latest_sync.last_sync_at.date()
                    if sync_date == date.today():
                        logger.info(f"MCC {mcc_account.mcc_id} 日期 {target_date.isoformat()} 数据已存在且是最新的，跳过同步（已有 {existing_count} 条记录）")
                        return {
                            "success": True,
                            "message": f"数据已存在且是最新的，跳过同步（已有 {existing_count} 条记录）",
                            "saved_count": existing_count,
                            "skipped": True
                        }
        
        try:
            # 调用Google Ads API获取数据
            api_data = self._fetch_google_ads_data(
                mcc_account,
                target_date
            )
            
            # 检查是否是配额限制
            if api_data.get("quota_exhausted"):
                logger.error(f"MCC {mcc_account.mcc_id} 同步失败: Google Ads API配额已用完")
                return {
                    "success": False,
                    "message": api_data.get("message", "Google Ads API配额已用完"),
                    "quota_exhausted": True,
                    "retry_after_seconds": api_data.get("retry_after_seconds")
                }
            
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
                    
                    # 查找或创建GoogleAdsApiData记录
                    existing = self.db.query(GoogleAdsApiData).filter(
                        GoogleAdsApiData.mcc_id == mcc_id,
                        GoogleAdsApiData.campaign_id == campaign_data.get("campaign_id"),
                        GoogleAdsApiData.date == target_date
                    ).first()
                    
                    if existing:
                        # 更新现有记录
                        existing.campaign_name = campaign_name
                        existing.status = campaign_data.get("status", "未知")
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
                            status=campaign_data.get("status", "未知"),
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
                    
                    # 如果提取到了平台信息，尝试匹配或创建AdCampaign记录
                    if platform_info and platform_info.get("platform_code"):
                        platform_code = platform_info.get("platform_code")
                        account_code = platform_info.get("account_code")
                        
                        # 查找平台
                        platform = self.db.query(AffiliatePlatform).filter(
                            AffiliatePlatform.platform_code == platform_code
                        ).first()
                        
                        if platform:
                            # 查找或创建联盟账号
                            affiliate_account_id = None
                            if account_code:
                                account = self.db.query(AffiliateAccount).filter(
                                    AffiliateAccount.user_id == mcc_account.user_id,
                                    AffiliateAccount.platform_id == platform.id,
                                    AffiliateAccount.account_code == account_code,
                                    AffiliateAccount.is_active == True
                                ).first()
                                if account:
                                    affiliate_account_id = account.id
                            
                            # 如果没找到匹配的账号，使用该平台下的第一个账号
                            if not affiliate_account_id:
                                account = self.db.query(AffiliateAccount).filter(
                                    AffiliateAccount.user_id == mcc_account.user_id,
                                    AffiliateAccount.platform_id == platform.id,
                                    AffiliateAccount.is_active == True
                                ).first()
                                if account:
                                    affiliate_account_id = account.id
                            
                            # 从广告系列名提取商家ID（格式：序号-平台-商家-国家-时间-MID）
                            merchant_id = None
                            parts = campaign_name.split('-')
                            if len(parts) >= 3:
                                merchant_id = parts[2]  # 第三个字段是商家
                            
                            # 查找或创建AdCampaign记录
                            if affiliate_account_id and merchant_id:
                                ad_campaign = self.db.query(AdCampaign).filter(
                                    AdCampaign.user_id == mcc_account.user_id,
                                    AdCampaign.campaign_name == campaign_name
                                ).first()
                                
                                if not ad_campaign:
                                    # 创建新的AdCampaign记录
                                    ad_campaign = AdCampaign(
                                        user_id=mcc_account.user_id,
                                        affiliate_account_id=affiliate_account_id,
                                        platform_id=platform.id,
                                        campaign_name=campaign_name,
                                        merchant_id=merchant_id,
                                        status="启用"
                                    )
                                    self.db.add(ad_campaign)
                                    logger.info(f"创建AdCampaign记录: {campaign_name}, 平台: {platform_code}, 商家: {merchant_id}")
                                elif ad_campaign.platform_id != platform.id:
                                    # 更新平台ID
                                    ad_campaign.platform_id = platform.id
                                    logger.info(f"更新AdCampaign平台ID: {campaign_name}, 平台: {platform_code}")
                    
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
            # MCC ID需要转换为customer_id格式（去掉横线，只保留数字）
            mcc_customer_id = mcc_account.mcc_id.replace("-", "").strip()
            
            # 验证MCC ID格式：必须是10位数字
            if not mcc_customer_id.isdigit() or len(mcc_customer_id) != 10:
                return {
                    "success": False,
                    "message": f"MCC ID格式错误：{mcc_account.mcc_id}。去掉横线后必须是10位数字，当前是{len(mcc_customer_id)}位：{mcc_customer_id}。请检查MCC ID是否正确。"
                }
            
            # 创建Google Ads客户端
            # 重要：当通过MCC访问客户账号时，必须设置login_customer_id为MCC的customer_id
            client = GoogleAdsClient.load_from_dict({
                "developer_token": settings.google_ads_shared_developer_token,
                "client_id": mcc_account.client_id,
                "client_secret": mcc_account.client_secret,
                "refresh_token": mcc_account.refresh_token,
                "login_customer_id": mcc_customer_id,  # 设置MCC的customer_id作为login-customer-id（必须是10位数字字符串）
                "use_proto_plus": True
            })
            
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
            
            for idx, customer_id in enumerate(customer_ids):
                try:
                    # 在请求之间添加延迟，避免触发速率限制
                    if idx > 0:
                        delay = 1.0  # 每个请求之间延迟1秒
                        logger.debug(f"等待 {delay} 秒后继续...")
                        time.sleep(delay)
                    
                    logger.info(f"正在查询客户账号 {customer_id} ({idx + 1}/{len(customer_ids)})...")
                    query = f"""
                        SELECT
                            campaign.id,
                            campaign.name,
                            campaign.status,
                            campaign_budget.amount_micros,
                            metrics.cost_micros,
                            metrics.impressions,
                            metrics.clicks,
                            metrics.average_cpc,
                            metrics.search_budget_lost_impression_share,
                            metrics.search_rank_lost_impression_share
                        FROM campaign
                        WHERE segments.date = '{date_str}'
                        -- 移除状态过滤，同步所有状态的广告系列（包括REMOVED，以便完整显示历史数据）
                    """
                    
                    ga_service = client.get_service("GoogleAdsService")
                    
                    # 添加重试机制处理配额耗尽错误
                    max_retries = 3
                    retry_delay = 5  # 初始延迟5秒
                    
                    for attempt in range(max_retries):
                        try:
                            response = ga_service.search(customer_id=customer_id, query=query)
                            break  # 成功，退出重试循环
                        except Exception as e:
                            # 检查是否是配额耗尽错误
                            is_quota_exhausted = (
                                "ResourceExhausted" in str(type(e).__name__) or
                                "429" in str(e) or
                                "quota" in str(e).lower() or
                                "Resource has been exhausted" in str(e)
                            )
                            
                            if is_quota_exhausted and attempt < max_retries - 1:
                                wait_time = retry_delay * (2 ** attempt)  # 指数退避：5秒、10秒、20秒
                                logger.warning(
                                    f"客户账号 {customer_id} 查询遇到配额限制，"
                                    f"等待 {wait_time} 秒后重试 ({attempt + 1}/{max_retries})..."
                                )
                                time.sleep(wait_time)
                                continue
                            else:
                                # 最后一次尝试或非配额错误，重新抛出异常
                                raise
                    
                    campaign_count = 0
                    for row in response:
                        budget_micros = row.campaign_budget.amount_micros if row.campaign_budget.amount_micros else 0
                        cost_micros = row.metrics.cost_micros if row.metrics.cost_micros else 0
                        cpc_micros = row.metrics.average_cpc if row.metrics.average_cpc else 0
                        
                        # 获取状态并转换为中文
                        status = row.campaign.status.name if hasattr(row.campaign.status, 'name') else str(row.campaign.status)
                        status_map = {
                            'ENABLED': '已启用',
                            'PAUSED': '已暂停',
                            'REMOVED': '已移除',
                            'UNKNOWN': '未知'
                        }
                        status_cn = status_map.get(status, status)
                        
                        all_campaigns.append({
                            "campaign_id": str(row.campaign.id),
                            "campaign_name": row.campaign.name,
                            "status": status_cn,
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
                    
                    # 检查是否是配额耗尽错误
                    is_quota_exhausted = (
                        "ResourceExhausted" in error_code or
                        "429" in error_message or
                        "quota" in error_message.lower() or
                        "Resource has been exhausted" in error_message
                    )
                    
                    # 检查是否是开发者令牌被禁止错误
                    is_developer_token_prohibited = (
                        "DEVELOPER_TOKEN_PROHIBITED" in error_code or
                        "Developer token is not allowed" in error_message or
                        "not allowed with project" in error_message
                    )
                    
                    # 检查是否是开发者令牌被禁止错误
                    is_developer_token_prohibited = (
                        "DEVELOPER_TOKEN_PROHIBITED" in error_code or
                        "Developer token is not allowed" in error_message or
                        "not allowed with project" in error_message
                    )
                    
                    # 检查是否是客户账号未启用错误
                    is_customer_not_enabled = (
                        "CUSTOMER_NOT_ENABLED" in error_code or
                        "PERMISSION_DENIED" in error_code or
                        "customer account can't be accessed" in error_message.lower() or
                        "not yet enabled" in error_message.lower() or
                        "has been deactivated" in error_message.lower()
                    )
                    
                    if is_developer_token_prohibited:
                        # 开发者令牌被禁止，返回明确的错误信息
                        logger.error(
                            f"查询客户账号 {customer_id} 失败: 开发者令牌不允许使用。"
                            f"新令牌可能需要等待Google审核（通常需要1-3个工作日），"
                            f"或者需要与正确的Google Cloud项目关联。"
                        )
                        return {
                            "success": False,
                            "message": "⚠️ 开发者令牌不允许使用。新令牌可能需要等待Google审核（通常需要1-3个工作日），或者需要与正确的Google Cloud项目关联。请联系管理员确认令牌状态。",
                            "developer_token_prohibited": True,
                            "error_code": error_code
                        }
                    
                    if is_quota_exhausted:
                        # 尝试从错误消息中提取重试时间
                        retry_seconds = None
                        if "Retry in" in error_message:
                            try:
                                import re
                                match = re.search(r"Retry in (\d+) seconds", error_message)
                                if match:
                                    retry_seconds = int(match.group(1))
                                    retry_hours = retry_seconds / 3600
                                    logger.error(
                                        f"查询客户账号 {customer_id} 失败: Google Ads API配额已耗尽。"
                                        f"需要等待约 {retry_hours:.1f} 小时（{retry_seconds} 秒）后重试。"
                                    )
                            except:
                                pass
                        
                        if retry_seconds is None:
                            logger.error(
                                f"查询客户账号 {customer_id} 失败: Google Ads API配额已耗尽。"
                                f"请稍后再试或联系Google Ads支持增加配额。"
                            )
                        
                        # 如果是配额错误，停止处理剩余账号，返回部分结果
                        if len(all_campaigns) > 0:
                            wait_msg = f"需要等待约 {retry_hours:.1f} 小时" if retry_seconds else "请稍后重试"
                            logger.warning(f"已获取 {len(all_campaigns)} 条广告系列，但因配额限制停止同步。{wait_msg}")
                            return {
                                "success": True,
                                "campaigns": all_campaigns,
                                "message": f"部分同步成功（{len(all_campaigns)} 条），但因API配额限制未完成所有账号。{wait_msg}",
                                "quota_exhausted": True,
                                "retry_after_seconds": retry_seconds
                            }
                        else:
                            wait_msg = f"需要等待约 {retry_hours:.1f} 小时后重试" if retry_seconds else "请稍后再试"
                            return {
                                "success": False,
                                "message": f"Google Ads API配额已耗尽。{wait_msg}或联系Google Ads支持增加配额。",
                                "quota_exhausted": True,
                                "retry_after_seconds": retry_seconds
                            }
                    elif is_customer_not_enabled:
                        # 客户账号未启用，跳过该账号继续处理
                        logger.warning(
                            f"客户账号 {customer_id} 未启用或已停用，跳过该账号: {error_message}"
                        )
                        continue
                    else:
                        logger.error(f"查询客户账号 {customer_id} 失败: {error_code} - {error_message}")
                        # 继续尝试下一个客户账号
                        continue
                except Exception as e:
                    error_str = str(e)
                    is_quota_exhausted = (
                        "ResourceExhausted" in str(type(e).__name__) or
                        "429" in error_str or
                        "quota" in error_str.lower() or
                        "Resource has been exhausted" in error_str
                    )
                    
                    # 检查是否是客户账号未启用错误
                    is_customer_not_enabled = (
                        "CUSTOMER_NOT_ENABLED" in error_str or
                        "PERMISSION_DENIED" in error_str or
                        "customer account can't be accessed" in error_str.lower() or
                        "not yet enabled" in error_str.lower() or
                        "has been deactivated" in error_str.lower()
                    )
                    
                    if is_quota_exhausted:
                        # 尝试从错误消息中提取重试时间
                        retry_seconds = None
                        if "Retry in" in error_str:
                            try:
                                import re
                                match = re.search(r"Retry in (\d+) seconds", error_str)
                                if match:
                                    retry_seconds = int(match.group(1))
                                    retry_hours = retry_seconds / 3600
                                    logger.error(
                                        f"处理客户账号 {customer_id} 时遇到配额限制: 需要等待约 {retry_hours:.1f} 小时（{retry_seconds} 秒）"
                                    )
                            except:
                                pass
                        
                        if retry_seconds is None:
                            logger.error(
                                f"处理客户账号 {customer_id} 时遇到配额限制: {error_str}"
                            )
                        
                        # 如果是配额错误，停止处理剩余账号，返回部分结果
                        if len(all_campaigns) > 0:
                            wait_msg = f"需要等待约 {retry_hours:.1f} 小时" if retry_seconds else "请稍后重试"
                            logger.warning(f"已获取 {len(all_campaigns)} 条广告系列，但因配额限制停止同步。{wait_msg}")
                            return {
                                "success": True,
                                "campaigns": all_campaigns,
                                "message": f"部分同步成功（{len(all_campaigns)} 条），但因API配额限制未完成所有账号。{wait_msg}",
                                "quota_exhausted": True,
                                "retry_after_seconds": retry_seconds
                            }
                        else:
                            wait_msg = f"需要等待约 {retry_hours:.1f} 小时后重试" if retry_seconds else "请稍后再试"
                            return {
                                "success": False,
                                "message": f"Google Ads API配额已耗尽。{wait_msg}或联系Google Ads支持增加配额。",
                                "quota_exhausted": True,
                                "retry_after_seconds": retry_seconds
                            }
                    elif is_customer_not_enabled:
                        # 客户账号未启用，跳过该账号继续处理
                        logger.warning(
                            f"客户账号 {customer_id} 未启用或已停用，跳过该账号: {error_str}"
                        )
                        continue
                    else:
                        logger.error(f"处理客户账号 {customer_id} 时出错: {e}", exc_info=True)
                        continue
            
            logger.info(f"成功从 {len(customer_ids)} 个客户账号获取 {len(all_campaigns)} 条广告系列数据")
            
            return {
                "success": True,
                "campaigns": all_campaigns
            }
            
        except GoogleAdsException as ex:
            error_code = ex.error.code().name if hasattr(ex.error, 'code') else "UNKNOWN"
            error_message = ex.error.message if hasattr(ex.error, 'message') else str(ex)
            
            # 检查是否是配额耗尽错误
            is_quota_exhausted = (
                "ResourceExhausted" in error_code or
                "429" in error_message or
                "quota" in error_message.lower() or
                "Resource has been exhausted" in error_message
            )
            
            if is_quota_exhausted:
                error_msg = "Google Ads API配额已耗尽。请稍后再试或联系Google Ads支持增加配额。"
            else:
                error_msg = f"Google Ads API错误: {error_code}"
                if error_message:
                    error_msg += f" - {error_message}"
            
            logger.error(error_msg)
            return {
                "success": False,
                "message": error_msg,
                "quota_exhausted": is_quota_exhausted
            }
        except Exception as e:
            error_str = str(e)
            is_quota_exhausted = (
                "ResourceExhausted" in str(type(e).__name__) or
                "429" in error_str or
                "quota" in error_str.lower() or
                "Resource has been exhausted" in error_str
            )
            
            if is_quota_exhausted:
                error_msg = "Google Ads API配额已耗尽。请稍后再试或联系Google Ads支持增加配额。"
            else:
                error_msg = f"API调用失败: {error_str}"
            
            logger.error(f"调用Google Ads API失败: {error_msg}", exc_info=True)
            return {
                "success": False,
                "message": error_msg,
                "quota_exhausted": is_quota_exhausted
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
                error_str = str(e)
                # 检查是否是开发者令牌被禁止错误
                is_developer_token_prohibited = (
                    "DEVELOPER_TOKEN_PROHIBITED" in error_str or
                    "Developer token is not allowed" in error_str or
                    "not allowed with project" in error_str
                )
                
                if is_developer_token_prohibited:
                    logger.error(f"使用CustomerClient查询失败: 开发者令牌不允许使用。新令牌可能需要等待Google审核（通常需要1-3个工作日）。")
                else:
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
                error_str = str(e)
                # 检查是否是开发者令牌被禁止错误
                is_developer_token_prohibited = (
                    "DEVELOPER_TOKEN_PROHIBITED" in error_str or
                    "Developer token is not allowed" in error_str or
                    "not allowed with project" in error_str
                )
                
                if is_developer_token_prohibited:
                    logger.error(f"使用CustomerService获取客户列表失败: 开发者令牌不允许使用。新令牌可能需要等待Google审核（通常需要1-3个工作日）。")
                    # 返回特殊错误，让上层知道是令牌问题
                    raise Exception("DEVELOPER_TOKEN_PROHIBITED: 开发者令牌不允许使用。新令牌可能需要等待Google审核（通常需要1-3个工作日）。")
                else:
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


