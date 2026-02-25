"""
Google Ads API 服务账号同步服务
使用服务账号（Service Account）认证方式从 Google Ads API 同步广告数据

特点：
1. 无需用户交互，服务器自动认证
2. 支持批量同步多个 MCC 账号
3. 内置配额管理和重试机制
4. 支持历史数据拉取
"""
import base64
import json
import logging
import time
from datetime import datetime, date, timedelta
from pathlib import Path
from typing import List, Dict, Optional, Any

from sqlalchemy.orm import Session

from app.config import settings
from app.models.google_ads_api_data import GoogleAdsApiData, GoogleMccAccount
from app.models.ad_campaign import AdCampaign
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.services.campaign_matcher import CampaignMatcher

logger = logging.getLogger(__name__)


class GoogleAdsServiceAccountSync:
    """
    基于服务账号的 Google Ads 数据同步服务
    
    使用方式：
    1. 配置全局服务账号（推荐）：在 .env 中设置 GOOGLE_ADS_SERVICE_ACCOUNT_FILE 或 GOOGLE_ADS_SERVICE_ACCOUNT_JSON_BASE64
    2. 配置MCC级别服务账号：在 GoogleMccAccount.service_account_json 中存储单独的服务账号配置
    """
    
    def __init__(self, db: Session):
        self.db = db
        self.developer_token = settings.google_ads_shared_developer_token
        self.matcher = CampaignMatcher(db)
        self._global_credentials = None
        
    def _load_global_service_account(self) -> Optional[Dict]:
        """
        加载全局服务账号配置
        
        优先级：
        1. 环境变量 GOOGLE_ADS_SERVICE_ACCOUNT_JSON_BASE64（Base64编码的JSON）
        2. 环境变量 GOOGLE_ADS_SERVICE_ACCOUNT_FILE（JSON文件路径）
        """
        if self._global_credentials:
            return self._global_credentials
            
        # 方式1：Base64编码的JSON
        if settings.google_ads_service_account_json_base64:
            try:
                json_content = base64.b64decode(settings.google_ads_service_account_json_base64).decode('utf-8')
                self._global_credentials = json.loads(json_content)
                logger.info("已从环境变量加载服务账号配置（Base64）")
                return self._global_credentials
            except Exception as e:
                logger.error(f"解析服务账号Base64配置失败: {e}")
        
        # 方式2：JSON文件路径
        if settings.google_ads_service_account_file:
            file_path = Path(settings.google_ads_service_account_file)
            if not file_path.is_absolute():
                # 相对路径，相对于backend目录
                file_path = Path(__file__).parent.parent.parent / file_path
            
            if file_path.exists():
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        self._global_credentials = json.load(f)
                    logger.info(f"已从文件加载服务账号配置: {file_path}")
                    return self._global_credentials
                except Exception as e:
                    logger.error(f"读取服务账号文件失败: {e}")
            else:
                logger.warning(f"服务账号文件不存在: {file_path}")
        
        return None
    
    @staticmethod
    def _safe_parse_service_account_json(raw: str) -> Optional[Dict]:
        """
        安全解析服务账号JSON，处理各种格式问题：
        - 正常JSON字符串
        - 双重JSON编码（json.dumps后再存了一次）
        - 带BOM的UTF-8
        - 首尾有多余引号/空白
        """
        if not raw or not raw.strip():
            return None
        
        text = raw.strip()
        # 去掉BOM
        if text.startswith('\ufeff'):
            text = text[1:]
        
        # 尝试直接解析
        try:
            result = json.loads(text)
            if isinstance(result, dict) and 'type' in result:
                return result
            # 如果解析出来是字符串，说明是双重编码
            if isinstance(result, str):
                result2 = json.loads(result)
                if isinstance(result2, dict) and 'type' in result2:
                    return result2
        except (json.JSONDecodeError, TypeError):
            pass
        
        # 尝试去掉首尾引号后解析（处理 '"{ ... }"' 的情况）
        if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
            try:
                inner = text[1:-1].replace('\\"', '"').replace("\\'", "'")
                result = json.loads(inner)
                if isinstance(result, dict) and 'type' in result:
                    return result
            except (json.JSONDecodeError, TypeError):
                pass
        
        return None

    def _get_service_account_credentials(self, mcc_account: GoogleMccAccount) -> Optional[Dict]:
        """
        获取服务账号凭证
        
        优先级：
        1. MCC账号级别的服务账号配置
        2. 全局服务账号配置（环境变量 / 文件）
        """
        # 优先使用MCC级别配置
        if mcc_account.service_account_json:
            parsed = self._safe_parse_service_account_json(mcc_account.service_account_json)
            if parsed:
                return parsed
            logger.warning(f"MCC {mcc_account.mcc_id} 的服务账号JSON解析失败（长度={len(mcc_account.service_account_json)}，前50字符={mcc_account.service_account_json[:50]!r}），将使用全局配置")
        
        # 使用全局配置
        return self._load_global_service_account()
    
    def _create_client(self, mcc_account: GoogleMccAccount):
        """
        创建 Google Ads 客户端（使用服务账号）
        
        Args:
            mcc_account: MCC账号对象
            
        Returns:
            GoogleAdsClient 实例
        """
        try:
            from google.ads.googleads.client import GoogleAdsClient
        except ImportError:
            raise ImportError("Google Ads API库未安装，请执行: pip install google-ads")
        
        if not self.developer_token:
            raise ValueError("缺少开发者令牌（GOOGLE_ADS_SHARED_DEVELOPER_TOKEN）")
        
        # MCC ID格式处理：去掉横线，只保留数字
        mcc_customer_id = mcc_account.mcc_id.replace("-", "").strip()
        
        # 验证MCC ID格式
        if not mcc_customer_id.isdigit() or len(mcc_customer_id) != 10:
            raise ValueError(f"MCC ID格式错误: {mcc_account.mcc_id}，去掉横线后必须是10位数字")
        
        # 判断使用哪种认证方式
        use_service_account = getattr(mcc_account, 'use_service_account', True)
        
        if use_service_account:
            # 服务账号模式
            credentials = self._get_service_account_credentials(mcc_account)
            if not credentials:
                raise ValueError(f"MCC {mcc_account.mcc_id} 未配置服务账号，请先配置全局服务账号或MCC级别服务账号")
            
            # 使用服务账号创建客户端
            sa_credentials = self._create_credentials_from_dict(credentials)
            client = GoogleAdsClient(
                credentials=sa_credentials,
                developer_token=self.developer_token,
                login_customer_id=mcc_customer_id
            )
        else:
            # OAuth模式（兼容旧版）
            if not mcc_account.client_id or not mcc_account.client_secret or not mcc_account.refresh_token:
                raise ValueError(f"MCC {mcc_account.mcc_id} 缺少OAuth配置")
            
            client = GoogleAdsClient.load_from_dict({
                "developer_token": self.developer_token,
                "client_id": mcc_account.client_id,
                "client_secret": mcc_account.client_secret,
                "refresh_token": mcc_account.refresh_token,
                "login_customer_id": mcc_customer_id,
                "use_proto_plus": True
            })
        
        return client, mcc_customer_id
    
    def _create_credentials_from_dict(self, credentials_dict: Dict):
        """
        从字典创建服务账号凭证对象
        """
        from google.oauth2 import service_account
        
        return service_account.Credentials.from_service_account_info(
            credentials_dict,
            scopes=["https://www.googleapis.com/auth/adwords"]
        )
    
    def get_accessible_customers(self, client, mcc_customer_id: str) -> List[Dict]:
        """
        获取MCC下所有有效的客户账号（CID）
        
        Args:
            client: GoogleAdsClient实例
            mcc_customer_id: MCC的customer_id
            
        Returns:
            客户账号列表，每个元素包含 id, name, status
        """
        try:
            from google.ads.googleads.errors import GoogleAdsException
        except ImportError:
            raise ImportError("Google Ads API库未安装")
        
        customers = []
        errors_collected = []
        
        try:
            # 方法1：使用 CustomerClient 查询（推荐）
            query = """
                SELECT
                    customer_client.id,
                    customer_client.descriptive_name,
                    customer_client.manager,
                    customer_client.status,
                    customer_client.currency_code
                FROM customer_client
                WHERE customer_client.manager = FALSE
                AND customer_client.status = 'ENABLED'
            """
            
            ga_service = client.get_service("GoogleAdsService")
            response = ga_service.search(customer_id=mcc_customer_id, query=query)
            
            for row in response:
                client_id = str(row.customer_client.id)
                if client_id != mcc_customer_id:
                    customers.append({
                        "id": client_id,
                        "name": row.customer_client.descriptive_name or "未命名",
                        "status": "ENABLED",
                        "currency_code": row.customer_client.currency_code or "USD"
                    })
            
            if customers:
                logger.info(f"MCC {mcc_customer_id} 找到 {len(customers)} 个有效客户账号")
                return customers
                
        except GoogleAdsException as ex:
            error_detail = str(ex)[:200]
            logger.error(f"通过CustomerClient查询失败: {error_detail}")
            errors_collected.append(f"CustomerClient: {error_detail}")
        except Exception as e:
            error_detail = str(e)[:200]
            logger.error(f"通过CustomerClient查询异常: {error_detail}")
            errors_collected.append(f"CustomerClient异常: {error_detail}")
        
        # 方法2：使用 CustomerService.list_accessible_customers 作为备选
        try:
            customer_service = client.get_service("CustomerService")
            accessible = customer_service.list_accessible_customers()
            
            for resource_name in accessible.resource_names:
                customer_id = resource_name.split("/")[-1]
                if customer_id != mcc_customer_id:
                    customers.append({
                        "id": customer_id,
                        "name": "未知",
                        "status": "UNKNOWN"
                    })
            
            if customers:
                logger.info(f"MCC {mcc_customer_id} 通过CustomerService找到 {len(customers)} 个客户账号")
                return customers
                
        except Exception as e:
            error_detail = str(e)[:200]
            logger.error(f"通过CustomerService查询失败: {error_detail}")
            errors_collected.append(f"CustomerService: {error_detail}")
        
        # 将收集到的错误信息保存到实例变量，供调用方使用
        self._last_customer_errors = errors_collected
        logger.error(f"MCC {mcc_customer_id} 未找到任何客户账号，错误: {'; '.join(errors_collected)}")
        return customers
    
    def fetch_campaign_data(
        self,
        client,
        customer_id: str,
        target_date: date,
        only_enabled: bool = False
    ) -> List[Dict]:
        """
        获取指定客户账号的广告系列数据
        
        Args:
            client: GoogleAdsClient实例
            customer_id: 客户账号ID
            target_date: 目标日期
            only_enabled: 是否只获取启用状态的广告系列（默认False=获取所有状态）
            
        Returns:
            广告系列数据列表
        """
        date_str = target_date.strftime("%Y-%m-%d")
        
        # 构建查询
        status_filter = "AND campaign.status = 'ENABLED'" if only_enabled else ""
        
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
            {status_filter}
        """
        
        campaigns = []
        
        try:
            ga_service = client.get_service("GoogleAdsService")
            response = ga_service.search(customer_id=customer_id, query=query)
            
            for row in response:
                # 金额从微单位转换为标准单位
                budget_micros = row.campaign_budget.amount_micros if row.campaign_budget.amount_micros else 0
                cost_micros = row.metrics.cost_micros if row.metrics.cost_micros else 0
                cpc_micros = row.metrics.average_cpc if row.metrics.average_cpc else 0
                
                # 状态转换（支持枚举名称、整数值、字符串）
                raw_status = row.campaign.status
                if hasattr(raw_status, 'name'):
                    status = raw_status.name
                elif isinstance(raw_status, int):
                    # Google Ads API 状态枚举值：2=ENABLED, 3=PAUSED, 4=REMOVED
                    int_status_map = {2: 'ENABLED', 3: 'PAUSED', 4: 'REMOVED'}
                    status = int_status_map.get(raw_status, 'UNKNOWN')
                else:
                    status = str(raw_status)
                
                status_map = {
                    'ENABLED': '已启用',
                    'PAUSED': '已暂停',
                    'REMOVED': '已移除',
                    'UNKNOWN': '未知'
                }
                status_cn = status_map.get(status, status)
                
                campaigns.append({
                    "customer_id": customer_id,  # 保存CID
                    "campaign_id": str(row.campaign.id),
                    "campaign_name": row.campaign.name,
                    "status": status_cn,
                    "budget": budget_micros / 1_000_000,
                    "cost": cost_micros / 1_000_000,
                    "impressions": row.metrics.impressions or 0,
                    "clicks": row.metrics.clicks or 0,
                    "cpc": cpc_micros / 1_000_000,
                    "is_budget_lost": row.metrics.search_budget_lost_impression_share or 0.0,
                    "is_rank_lost": row.metrics.search_rank_lost_impression_share or 0.0,
                })
                
        except Exception as e:
            logger.error(f"查询客户账号 {customer_id} 广告系列数据失败: {e}")
            raise
        
        return campaigns
    
    def fetch_campaign_bid_strategies(
        self,
        client,
        customer_id: str
    ) -> List[Dict]:
        """
        获取广告系列的出价策略信息
        
        Args:
            client: GoogleAdsClient实例
            customer_id: 客户账号ID
            
        Returns:
            出价策略列表
        """
        query = """
            SELECT
                campaign.id,
                campaign.name,
                campaign.status,
                campaign.bidding_strategy_type,
                campaign.manual_cpc.enhanced_cpc_enabled,
                metrics.average_cpc
            FROM campaign
            WHERE campaign.status = 'ENABLED'
        """
        
        strategies = []
        
        try:
            ga_service = client.get_service("GoogleAdsService")
            response = ga_service.search(customer_id=customer_id, query=query)
            
            # 出价策略类型映射
            strategy_name_map = {
                'MANUAL_CPC': '每次点击费用人工出价',
                'MAXIMIZE_CLICKS': '尽可能争取更多点击次数',
                'MAXIMIZE_CONVERSIONS': '尽可能提高转化次数',
                'MAXIMIZE_CONVERSION_VALUE': '尽可能提高转化价值',
                'TARGET_CPA': '目标每次转化费用',
                'TARGET_ROAS': '目标广告支出回报率',
                'TARGET_IMPRESSION_SHARE': '目标展示次数份额',
                'ENHANCED_CPC': '智能点击付费',
            }
            
            for row in response:
                # 获取出价策略类型
                raw_strategy = row.campaign.bidding_strategy_type
                if hasattr(raw_strategy, 'name'):
                    strategy_type = raw_strategy.name
                elif isinstance(raw_strategy, int):
                    # 枚举值映射
                    int_map = {
                        0: 'UNSPECIFIED', 1: 'UNKNOWN', 2: 'COMMISSION',
                        3: 'ENHANCED_CPC', 4: 'INVALID', 5: 'MANUAL_CPC',
                        6: 'MANUAL_CPM', 7: 'MANUAL_CPV', 8: 'MAXIMIZE_CONVERSIONS',
                        9: 'MAXIMIZE_CONVERSION_VALUE', 10: 'PAGE_ONE_PROMOTED',
                        11: 'PERCENT_CPC', 12: 'TARGET_CPA', 13: 'TARGET_CPM',
                        14: 'TARGET_IMPRESSION_SHARE', 15: 'TARGET_OUTRANK_SHARE',
                        16: 'TARGET_ROAS', 17: 'TARGET_SPEND', 18: 'MAXIMIZE_CLICKS'
                    }
                    strategy_type = int_map.get(raw_strategy, 'UNKNOWN')
                else:
                    strategy_type = str(raw_strategy)
                
                is_manual = strategy_type == 'MANUAL_CPC'
                
                # 出价上限（暂不获取，API字段不稳定）
                cpc_ceiling = 0
                
                # 获取智能点击付费设置
                enhanced_cpc = False
                try:
                    if hasattr(row.campaign, 'manual_cpc') and row.campaign.manual_cpc.enhanced_cpc_enabled:
                        enhanced_cpc = row.campaign.manual_cpc.enhanced_cpc_enabled
                except:
                    pass
                
                avg_cpc = (row.metrics.average_cpc or 0) / 1_000_000
                
                strategies.append({
                    "customer_id": customer_id,
                    "campaign_id": str(row.campaign.id),
                    "campaign_name": row.campaign.name,
                    "bidding_strategy_type": strategy_type,
                    "bidding_strategy_name": strategy_name_map.get(strategy_type, strategy_type),
                    "is_manual_cpc": is_manual,
                    "enhanced_cpc_enabled": enhanced_cpc,
                    "max_cpc_limit": cpc_ceiling,
                    "avg_cpc": avg_cpc,
                })
                
        except Exception as e:
            logger.error(f"查询客户账号 {customer_id} 出价策略失败: {e}")
            raise
        
        return strategies
    
    def fetch_keyword_bids(
        self,
        client,
        customer_id: str,
        campaign_id: Optional[str] = None
    ) -> List[Dict]:
        """
        获取关键词的CPC出价数据
        
        Args:
            client: GoogleAdsClient实例
            customer_id: 客户账号ID
            campaign_id: 可选，指定广告系列ID
            
        Returns:
            关键词出价列表
        """
        campaign_filter = f"AND campaign.id = {campaign_id}" if campaign_id else ""
        
        query = f"""
            SELECT
                campaign.id,
                campaign.name,
                ad_group.id,
                ad_group.name,
                ad_group_criterion.criterion_id,
                ad_group_criterion.keyword.text,
                ad_group_criterion.keyword.match_type,
                ad_group_criterion.cpc_bid_micros,
                ad_group_criterion.effective_cpc_bid_micros,
                ad_group_criterion.status,
                ad_group_criterion.quality_info.quality_score,
                metrics.average_cpc
            FROM keyword_view
            WHERE campaign.status = 'ENABLED'
              AND ad_group.status = 'ENABLED'
              AND ad_group_criterion.status != 'REMOVED'
              {campaign_filter}
        """
        
        keywords = []
        
        try:
            ga_service = client.get_service("GoogleAdsService")
            response = ga_service.search(customer_id=customer_id, query=query)
            
            match_type_map = {
                'EXACT': '完全匹配',
                'PHRASE': '词组匹配',
                'BROAD': '广泛匹配',
            }
            
            for row in response:
                # 获取匹配类型
                raw_match = row.ad_group_criterion.keyword.match_type
                if hasattr(raw_match, 'name'):
                    match_type = raw_match.name
                elif isinstance(raw_match, int):
                    int_map = {0: 'UNSPECIFIED', 1: 'UNKNOWN', 2: 'EXACT', 3: 'PHRASE', 4: 'BROAD'}
                    match_type = int_map.get(raw_match, 'UNKNOWN')
                else:
                    match_type = str(raw_match)
                
                # 获取状态
                raw_status = row.ad_group_criterion.status
                if hasattr(raw_status, 'name'):
                    status = raw_status.name
                elif isinstance(raw_status, int):
                    int_map = {0: 'UNSPECIFIED', 1: 'UNKNOWN', 2: 'ENABLED', 3: 'PAUSED', 4: 'REMOVED'}
                    status = int_map.get(raw_status, 'UNKNOWN')
                else:
                    status = str(raw_status)
                
                # CPC数据（微单位转标准单位）
                max_cpc = (row.ad_group_criterion.cpc_bid_micros or 0) / 1_000_000
                effective_cpc = (row.ad_group_criterion.effective_cpc_bid_micros or 0) / 1_000_000
                avg_cpc = (row.metrics.average_cpc or 0) / 1_000_000
                
                # 质量得分
                quality_score = None
                try:
                    if hasattr(row.ad_group_criterion, 'quality_info') and row.ad_group_criterion.quality_info.quality_score:
                        quality_score = row.ad_group_criterion.quality_info.quality_score
                except:
                    pass
                
                keywords.append({
                    "customer_id": customer_id,
                    "campaign_id": str(row.campaign.id),
                    "campaign_name": row.campaign.name,
                    "ad_group_id": str(row.ad_group.id),
                    "ad_group_name": row.ad_group.name,
                    "criterion_id": str(row.ad_group_criterion.criterion_id),
                    "keyword_text": row.ad_group_criterion.keyword.text,
                    "match_type": match_type,
                    "match_type_cn": match_type_map.get(match_type, match_type),
                    "max_cpc": max_cpc,
                    "effective_cpc": effective_cpc,
                    "avg_cpc": avg_cpc,
                    "status": status,
                    "quality_score": quality_score,
                })
                
        except Exception as e:
            logger.error(f"查询客户账号 {customer_id} 关键词出价失败: {e}")
            raise
        
        return keywords
    
    def change_to_manual_cpc(
        self,
        client,
        customer_id: str,
        campaign_id: str,
        cpc_bid_ceiling_micros: Optional[int] = None
    ) -> Dict:
        """
        将广告系列出价策略改为人工CPC
        
        Args:
            client: GoogleAdsClient实例
            customer_id: 客户账号ID
            campaign_id: 广告系列ID
            cpc_bid_ceiling_micros: 可选，CPC出价上限（微单位）
            
        Returns:
            操作结果
        """
        from google.protobuf import field_mask_pb2
        
        try:
            campaign_service = client.get_service("CampaignService")
            
            # 构建资源名称
            campaign_resource = f"customers/{customer_id}/campaigns/{campaign_id}"
            
            # 创建 campaign 对象
            campaign = client.get_type("Campaign")
            campaign.resource_name = campaign_resource
            
            # 设置为人工CPC，关闭智能点击付费
            campaign.manual_cpc.enhanced_cpc_enabled = False
            
            # 使用 protobuf 的 FieldMask
            field_mask = field_mask_pb2.FieldMask(paths=["manual_cpc.enhanced_cpc_enabled"])
            
            # 创建操作
            operation = client.get_type("CampaignOperation")
            operation.update_mask.CopyFrom(field_mask)
            operation.update.CopyFrom(campaign)
            
            # 执行更新
            response = campaign_service.mutate_campaigns(
                customer_id=customer_id,
                operations=[operation]
            )
            
            logger.info(f"广告系列 {campaign_id} 已切换为人工CPC出价")
            
            return {
                "success": True,
                "message": "出价策略已切换为人工CPC",
                "resource_name": response.results[0].resource_name
            }
            
        except Exception as e:
            logger.error(f"切换广告系列 {campaign_id} 出价策略失败: {e}")
            return {
                "success": False,
                "message": str(e)
            }
    
    def set_keyword_cpc(
        self,
        client,
        customer_id: str,
        ad_group_id: str,
        criterion_id: str,
        cpc_bid_micros: int
    ) -> Dict:
        """
        设置关键词的最高CPC出价
        
        Args:
            client: GoogleAdsClient实例
            customer_id: 客户账号ID
            ad_group_id: 广告组ID
            criterion_id: 关键词 criterion ID
            cpc_bid_micros: CPC出价（微单位）
            
        Returns:
            操作结果
        """
        from google.protobuf import field_mask_pb2
        
        try:
            criterion_service = client.get_service("AdGroupCriterionService")
            
            # 构建资源名称
            criterion_resource = f"customers/{customer_id}/adGroupCriteria/{ad_group_id}~{criterion_id}"
            
            # 创建 criterion 对象
            criterion = client.get_type("AdGroupCriterion")
            criterion.resource_name = criterion_resource
            criterion.cpc_bid_micros = cpc_bid_micros
            
            # 使用 protobuf 的 FieldMask
            field_mask = field_mask_pb2.FieldMask(paths=["cpc_bid_micros"])
            
            # 创建操作
            operation = client.get_type("AdGroupCriterionOperation")
            operation.update_mask.CopyFrom(field_mask)
            operation.update.CopyFrom(criterion)
            
            # 执行更新
            response = criterion_service.mutate_ad_group_criteria(
                customer_id=customer_id,
                operations=[operation]
            )
            
            logger.info(f"关键词 {criterion_id} CPC已设置为 {cpc_bid_micros / 1_000_000}")
            
            return {
                "success": True,
                "message": f"CPC已设置为 {cpc_bid_micros / 1_000_000}",
                "resource_name": response.results[0].resource_name
            }
            
        except Exception as e:
            logger.error(f"设置关键词 {criterion_id} CPC失败: {e}")
            return {
                "success": False,
                "message": str(e)
            }
    
    def toggle_keyword_status(
        self,
        client,
        customer_id: str,
        ad_group_id: str,
        criterion_id: str,
        new_status: str  # ENABLED or PAUSED
    ) -> Dict:
        """
        切换关键词状态（启用/暂停）
        注意：否定关键词（Negative Keywords）不能更新状态
        """
        from google.protobuf import field_mask_pb2
        
        try:
            # 首先查询该关键词是否为否定关键词
            ga_service = client.get_service("GoogleAdsService")
            query = f"""
                SELECT
                    ad_group_criterion.criterion_id,
                    ad_group_criterion.negative
                FROM ad_group_criterion
                WHERE ad_group_criterion.criterion_id = {criterion_id}
                  AND ad_group.id = {ad_group_id}
            """
            
            try:
                response = ga_service.search(customer_id=customer_id, query=query)
                for row in response:
                    if row.ad_group_criterion.negative:
                        return {
                            "success": False,
                            "message": "否定关键词不能更改状态，只能删除后重新添加"
                        }
            except Exception as query_error:
                logger.warning(f"查询关键词类型失败: {query_error}")
                # 继续尝试更新，让API返回具体错误
            
            criterion_service = client.get_service("AdGroupCriterionService")
            
            # 构建资源名称
            criterion_resource = f"customers/{customer_id}/adGroupCriteria/{ad_group_id}~{criterion_id}"
            
            # 创建 criterion 对象
            criterion = client.get_type("AdGroupCriterion")
            criterion.resource_name = criterion_resource
            
            # 设置状态
            status_enum = client.enums.AdGroupCriterionStatusEnum
            if new_status == "ENABLED":
                criterion.status = status_enum.ENABLED
            else:
                criterion.status = status_enum.PAUSED
            
            # 使用 protobuf 的 FieldMask
            field_mask = field_mask_pb2.FieldMask(paths=["status"])
            
            # 创建操作
            operation = client.get_type("AdGroupCriterionOperation")
            operation.update_mask.CopyFrom(field_mask)
            operation.update.CopyFrom(criterion)
            
            # 执行更新
            response = criterion_service.mutate_ad_group_criteria(
                customer_id=customer_id,
                operations=[operation]
            )
            
            logger.info(f"关键词 {criterion_id} 状态已更改为 {new_status}")
            
            return {
                "success": True,
                "message": f"状态已更改为 {new_status}",
                "resource_name": response.results[0].resource_name
            }
            
        except Exception as e:
            error_msg = str(e)
            # 处理否定关键词错误
            if "CANT_UPDATE_NEGATIVE" in error_msg or "Negative" in error_msg:
                return {
                    "success": False,
                    "message": "否定关键词不能更改状态"
                }
            logger.error(f"切换关键词 {criterion_id} 状态失败: {e}")
            return {
                "success": False,
                "message": error_msg
            }
    
    def add_keyword(
        self,
        client,
        customer_id: str,
        ad_group_id: str,
        keyword_text: str,
        match_type: str,  # EXACT, PHRASE, BROAD
        cpc_bid_micros: Optional[int] = None
    ) -> Dict:
        """
        添加关键词
        """
        try:
            criterion_service = client.get_service("AdGroupCriterionService")
            
            # 创建关键词
            criterion = client.get_type("AdGroupCriterion")
            criterion.ad_group = f"customers/{customer_id}/adGroups/{ad_group_id}"
            criterion.status = client.enums.AdGroupCriterionStatusEnum.ENABLED
            
            # 设置关键词信息
            criterion.keyword.text = keyword_text
            match_type_enum = client.enums.KeywordMatchTypeEnum
            if match_type.upper() == "EXACT":
                criterion.keyword.match_type = match_type_enum.EXACT
            elif match_type.upper() == "PHRASE":
                criterion.keyword.match_type = match_type_enum.PHRASE
            else:
                criterion.keyword.match_type = match_type_enum.BROAD
            
            # 设置CPC出价（如果提供）
            if cpc_bid_micros:
                criterion.cpc_bid_micros = cpc_bid_micros
            
            # 创建操作
            operation = client.get_type("AdGroupCriterionOperation")
            operation.create.CopyFrom(criterion)
            
            # 执行创建
            response = criterion_service.mutate_ad_group_criteria(
                customer_id=customer_id,
                operations=[operation]
            )
            
            resource_name = response.results[0].resource_name
            # 从资源名称中提取 criterion_id
            criterion_id = resource_name.split("~")[-1] if "~" in resource_name else None
            
            logger.info(f"关键词 '{keyword_text}' 添加成功")
            
            return {
                "success": True,
                "message": f"关键词 '{keyword_text}' 添加成功",
                "resource_name": resource_name,
                "criterion_id": criterion_id
            }
            
        except Exception as e:
            logger.error(f"添加关键词 '{keyword_text}' 失败: {e}")
            return {
                "success": False,
                "message": str(e)
            }
    
    def remove_keyword(
        self,
        client,
        customer_id: str,
        ad_group_id: str,
        criterion_id: str
    ) -> Dict:
        """
        删除关键词
        """
        try:
            criterion_service = client.get_service("AdGroupCriterionService")
            
            # 构建资源名称
            criterion_resource = f"customers/{customer_id}/adGroupCriteria/{ad_group_id}~{criterion_id}"
            
            # 创建删除操作
            operation = client.get_type("AdGroupCriterionOperation")
            operation.remove = criterion_resource
            
            # 执行删除
            response = criterion_service.mutate_ad_group_criteria(
                customer_id=customer_id,
                operations=[operation]
            )
            
            logger.info(f"关键词 {criterion_id} 已删除")
            
            return {
                "success": True,
                "message": "关键词已删除",
                "resource_name": response.results[0].resource_name
            }
            
        except Exception as e:
            logger.error(f"删除关键词 {criterion_id} 失败: {e}")
            return {
                "success": False,
                "message": str(e)
            }
    
    def fetch_ad_groups(
        self,
        client,
        customer_id: str,
        campaign_id: Optional[str] = None
    ) -> List[Dict]:
        """
        获取广告组列表
        """
        campaign_filter = f"AND campaign.id = {campaign_id}" if campaign_id else ""
        
        query = f"""
            SELECT
                campaign.id,
                campaign.name,
                ad_group.id,
                ad_group.name,
                ad_group.status
            FROM ad_group
            WHERE campaign.status = 'ENABLED'
              AND ad_group.status != 'REMOVED'
              {campaign_filter}
        """
        
        ad_groups = []
        
        try:
            ga_service = client.get_service("GoogleAdsService")
            response = ga_service.search(customer_id=customer_id, query=query)
            
            for row in response:
                ad_groups.append({
                    "customer_id": customer_id,
                    "campaign_id": str(row.campaign.id),
                    "campaign_name": row.campaign.name,
                    "ad_group_id": str(row.ad_group.id),
                    "ad_group_name": row.ad_group.name,
                    "status": str(row.ad_group.status.name) if hasattr(row.ad_group.status, 'name') else str(row.ad_group.status)
                })
                
        except Exception as e:
            logger.error(f"获取客户账号 {customer_id} 广告组失败: {e}")
        
        return ad_groups
    
    def sync_mcc_data(
        self,
        mcc_id: int,
        target_date: Optional[date] = None,
        force_refresh: bool = False,
        only_enabled: bool = False
    ) -> Dict:
        """
        同步指定MCC的Google Ads数据
        
        Args:
            mcc_id: MCC账号ID（数据库ID）
            target_date: 目标日期，默认为昨天
            force_refresh: 是否强制刷新
            only_enabled: 是否只同步启用状态的广告系列（默认False=所有状态）
            
        Returns:
            同步结果
        """
        if target_date is None:
            target_date = date.today() - timedelta(days=1)
        
        # 获取MCC账号
        mcc_account = self.db.query(GoogleMccAccount).filter(
            GoogleMccAccount.id == mcc_id,
            GoogleMccAccount.is_active == True
        ).first()
        
        if not mcc_account:
            return {"success": False, "message": "MCC账号不存在或已停用"}
        
        # 增量同步检查
        if not force_refresh:
            existing_count = self.db.query(GoogleAdsApiData).filter(
                GoogleAdsApiData.mcc_id == mcc_id,
                GoogleAdsApiData.date == target_date
            ).count()
            
            if existing_count > 0:
                # 检查是否今天已同步
                latest = self.db.query(GoogleAdsApiData).filter(
                    GoogleAdsApiData.mcc_id == mcc_id,
                    GoogleAdsApiData.date == target_date
                ).order_by(GoogleAdsApiData.last_sync_at.desc()).first()
                
                if latest and latest.last_sync_at and latest.last_sync_at.date() == date.today():
                    logger.info(f"MCC {mcc_account.mcc_id} 日期 {target_date} 数据已存在且是最新的，跳过同步")
                    return {
                        "success": True,
                        "skipped": True,
                        "message": f"数据已存在（{existing_count}条），今日已同步",
                        "saved_count": existing_count
                    }
        
        try:
            # 自动修复：如果MCC的服务账号JSON无法解析，尝试用全局配置修复并更新DB
            if mcc_account.service_account_json:
                parsed = self._safe_parse_service_account_json(mcc_account.service_account_json)
                if not parsed:
                    global_creds = self._load_global_service_account()
                    if global_creds:
                        fixed_json = json.dumps(global_creds, ensure_ascii=False)
                        mcc_account.service_account_json = fixed_json
                        mcc_account.use_service_account = True
                        self.db.add(mcc_account)
                        self.db.commit()
                        logger.info(f"MCC {mcc_account.mcc_id} 的服务账号JSON已自动修复（从全局配置）")

            # 创建客户端
            client, mcc_customer_id = self._create_client(mcc_account)
            
            # 获取客户账号列表
            customers = self.get_accessible_customers(client, mcc_customer_id)
            
            if not customers:
                error_details = getattr(self, '_last_customer_errors', [])
                if error_details:
                    msg = f"MCC下没有找到有效的客户账号。原因: {'; '.join(error_details)}"
                else:
                    msg = "MCC下没有找到有效的客户账号（API返回空列表，请检查服务账号权限）"
                self._update_mcc_sync_status(mcc_account, "warning", msg[:500])
                return {
                    "success": True,
                    "message": msg,
                    "saved_count": 0,
                    "customers_count": 0
                }
            
            # 更新MCC的客户账号数
            mcc_account.total_customers = len(customers)
            
            # 自动检测货币类型：如果子账号中有CNY，则标记MCC为CNY
            detected_currencies = set(c.get("currency_code", "USD") for c in customers)
            if "CNY" in detected_currencies:
                if getattr(mcc_account, 'currency', 'USD') != 'CNY':
                    mcc_account.currency = 'CNY'
                    logger.info(f"MCC {mcc_account.mcc_id} 检测到人民币账户，已自动标记为CNY")
            elif detected_currencies and "CNY" not in detected_currencies:
                dominant_currency = max(detected_currencies, key=lambda c: sum(1 for x in customers if x.get("currency_code") == c))
                if getattr(mcc_account, 'currency', None) != dominant_currency:
                    mcc_account.currency = dominant_currency
                    logger.info(f"MCC {mcc_account.mcc_id} 检测到货币类型: {dominant_currency}")
            
            # 逐个客户账号查询广告系列数据
            all_campaigns = []
            request_delay = settings.google_ads_request_delay_seconds
            
            for idx, customer in enumerate(customers):
                customer_id = customer["id"]
                
                try:
                    # 请求延迟
                    if idx > 0 and request_delay > 0:
                        time.sleep(request_delay)
                    
                    campaigns = self.fetch_campaign_data(
                        client,
                        customer_id,
                        target_date,
                        only_enabled=only_enabled
                    )
                    
                    all_campaigns.extend(campaigns)
                    logger.debug(f"客户账号 {customer_id} 获取到 {len(campaigns)} 个广告系列")
                    
                except Exception as e:
                    error_str = str(e)
                    
                    # 检查是否是配额限制
                    if self._is_quota_error(error_str):
                        logger.error(f"客户账号 {customer_id} 遇到配额限制")
                        # 返回部分结果
                        if all_campaigns:
                            break
                        else:
                            return {
                                "success": False,
                                "message": "API配额已用完，请稍后重试",
                                "quota_exhausted": True
                            }
                    
                    # 检查是否是账号未启用
                    if self._is_customer_not_enabled(error_str):
                        logger.warning(f"客户账号 {customer_id} 未启用，跳过")
                        continue
                    
                    logger.error(f"客户账号 {customer_id} 查询失败: {e}")
                    continue
            
            # 保存数据到数据库
            saved_count = self._save_campaigns_data(
                mcc_account,
                all_campaigns,
                target_date
            )
            
            # 更新同步状态
            self._update_mcc_sync_status(
                mcc_account,
                "success",
                f"成功同步 {saved_count} 条数据",
                target_date
            )
            
            return {
                "success": True,
                "message": f"成功同步 {saved_count} 条广告系列数据",
                "saved_count": saved_count,
                "customers_count": len(customers),
                "date": target_date.isoformat()
            }
            
        except Exception as e:
            error_msg = str(e)
            logger.error(f"同步MCC {mcc_account.mcc_id} 失败: {error_msg}", exc_info=True)
            
            self._update_mcc_sync_status(mcc_account, "failed", error_msg)
            
            return {
                "success": False,
                "message": f"同步失败: {error_msg}",
                "quota_exhausted": self._is_quota_error(error_msg)
            }
    
    def _save_campaigns_data(
        self,
        mcc_account: GoogleMccAccount,
        campaigns: List[Dict],
        target_date: date
    ) -> int:
        """保存广告系列数据到数据库"""
        saved_count = 0
        
        for campaign_data in campaigns:
            try:
                campaign_name = campaign_data.get("campaign_name", "")
                
                # 从广告系列名提取平台信息
                platform_info = self.matcher.extract_platform_from_campaign_name(
                    campaign_name,
                    mcc_account.user_id
                )
                
                # 查找或更新记录
                existing = self.db.query(GoogleAdsApiData).filter(
                    GoogleAdsApiData.mcc_id == mcc_account.id,
                    GoogleAdsApiData.campaign_id == campaign_data.get("campaign_id"),
                    GoogleAdsApiData.date == target_date
                ).first()
                
                # 应用货币转换
                raw_cost = campaign_data.get("cost", 0)
                raw_budget = campaign_data.get("budget", 0)
                raw_cpc = campaign_data.get("cpc", 0)
                
                # D1 修复：存储原始货币值，不做转换（读取时统一转换）
                converted_cost = raw_cost
                converted_budget = raw_budget
                converted_cpc = raw_cpc
                
                if existing:
                    # 更新现有记录
                    existing.customer_id = campaign_data.get("customer_id")  # CID
                    existing.campaign_name = campaign_name
                    existing.status = campaign_data.get("status", "未知")
                    existing.budget = converted_budget
                    existing.cost = converted_cost
                    existing.impressions = campaign_data.get("impressions", 0)
                    existing.clicks = campaign_data.get("clicks", 0)
                    existing.cpc = converted_cpc
                    existing.is_budget_lost = campaign_data.get("is_budget_lost", 0)
                    existing.is_rank_lost = campaign_data.get("is_rank_lost", 0)
                    existing.extracted_platform_code = platform_info.get("platform_code") if platform_info else None
                    existing.extracted_account_code = platform_info.get("account_code") if platform_info else None
                    existing.last_sync_at = datetime.now()
                else:
                    # 创建新记录（使用已转换的货币值）
                    new_data = GoogleAdsApiData(
                        mcc_id=mcc_account.id,
                        user_id=mcc_account.user_id,
                        customer_id=campaign_data.get("customer_id"),  # CID
                        campaign_id=campaign_data.get("campaign_id"),
                        campaign_name=campaign_name,
                        date=target_date,
                        status=campaign_data.get("status", "未知"),
                        budget=converted_budget,
                        cost=converted_cost,
                        impressions=campaign_data.get("impressions", 0),
                        clicks=campaign_data.get("clicks", 0),
                        cpc=converted_cpc,
                        is_budget_lost=campaign_data.get("is_budget_lost", 0),
                        is_rank_lost=campaign_data.get("is_rank_lost", 0),
                        extracted_platform_code=platform_info.get("platform_code") if platform_info else None,
                        extracted_account_code=platform_info.get("account_code") if platform_info else None
                    )
                    self.db.add(new_data)
                
                # 同步更新AdCampaign记录
                self._sync_ad_campaign(mcc_account, campaign_data, platform_info)
                
                saved_count += 1
                
            except Exception as e:
                logger.error(f"保存广告系列数据失败: {e}")
                continue
        
        # 更新MCC的广告系列总数
        mcc_account.total_campaigns = saved_count
        
        self.db.commit()
        return saved_count
    
    def _sync_ad_campaign(
        self,
        mcc_account: GoogleMccAccount,
        campaign_data: Dict,
        platform_info: Optional[Dict]
    ):
        """同步更新AdCampaign记录"""
        if not platform_info or not platform_info.get("platform_code"):
            return
        
        campaign_name = campaign_data.get("campaign_name", "")
        platform_code = platform_info.get("platform_code")
        account_code = platform_info.get("account_code")
        
        # 查找平台
        platform = self.db.query(AffiliatePlatform).filter(
            AffiliatePlatform.platform_code == platform_code
        ).first()
        
        if not platform:
            return
        
        # 查找联盟账号
        affiliate_account = None
        if account_code:
            affiliate_account = self.db.query(AffiliateAccount).filter(
                AffiliateAccount.user_id == mcc_account.user_id,
                AffiliateAccount.platform_id == platform.id,
                AffiliateAccount.account_code == account_code,
                AffiliateAccount.is_active == True
            ).first()
        
        if not affiliate_account:
            affiliate_account = self.db.query(AffiliateAccount).filter(
                AffiliateAccount.user_id == mcc_account.user_id,
                AffiliateAccount.platform_id == platform.id,
                AffiliateAccount.is_active == True
            ).first()
        
        if not affiliate_account:
            return
        
        # 从广告系列名提取商家ID
        merchant_id = None
        parts = campaign_name.split('-')
        if len(parts) >= 3:
            merchant_id = parts[2]
        
        if not merchant_id:
            return
        
        # 查找或创建AdCampaign
        ad_campaign = self.db.query(AdCampaign).filter(
            AdCampaign.user_id == mcc_account.user_id,
            AdCampaign.campaign_name == campaign_name
        ).first()
        
        if not ad_campaign:
            ad_campaign = AdCampaign(
                user_id=mcc_account.user_id,
                affiliate_account_id=affiliate_account.id,
                platform_id=platform.id,
                campaign_name=campaign_name,
                merchant_id=merchant_id,
                status="启用"
            )
            self.db.add(ad_campaign)
    
    def _update_mcc_sync_status(
        self,
        mcc_account: GoogleMccAccount,
        status: str,
        message: str,
        sync_date: Optional[date] = None
    ):
        """更新MCC同步状态"""
        mcc_account.last_sync_status = status
        mcc_account.last_sync_message = message
        mcc_account.last_sync_at = datetime.now()
        if sync_date:
            mcc_account.last_sync_date = sync_date
        self.db.commit()
    
    def _is_quota_error(self, error_str: str) -> bool:
        """检查是否是配额限制错误"""
        keywords = [
            "ResourceExhausted",
            "429",
            "quota",
            "QUOTA",
            "Resource has been exhausted"
        ]
        return any(kw in error_str for kw in keywords)
    
    def _is_customer_not_enabled(self, error_str: str) -> bool:
        """检查是否是客户账号未启用错误"""
        keywords = [
            "CUSTOMER_NOT_ENABLED",
            "PERMISSION_DENIED",
            "customer account can't be accessed",
            "not yet enabled",
            "has been deactivated"
        ]
        return any(kw.lower() in error_str.lower() for kw in keywords)
    
    def sync_all_mccs(
        self,
        target_date: Optional[date] = None,
        batch_size: Optional[int] = None,
        only_enabled: bool = False,
        force_refresh: bool = False
    ) -> Dict:
        """
        批量同步所有活跃MCC的数据
        
        Args:
            target_date: 目标日期
            batch_size: 每批MCC数量
            only_enabled: 是否只同步启用状态的广告系列（默认False=所有状态）
            force_refresh: 是否强制刷新（即使数据已存在也重新同步，确保数据精准）
            
        Returns:
            同步结果汇总
        """
        if target_date is None:
            target_date = date.today() - timedelta(days=1)
        
        if batch_size is None:
            batch_size = settings.google_ads_sync_batch_size
        
        batch_delay = settings.google_ads_sync_delay_seconds
        
        # 获取所有活跃MCC
        active_mccs = self.db.query(GoogleMccAccount).filter(
            GoogleMccAccount.is_active == True
        ).all()
        
        if not active_mccs:
            return {
                "success": True,
                "message": "没有活跃的MCC账号",
                "total_mccs": 0,
                "success_count": 0,
                "fail_count": 0,
                "total_saved": 0
            }
        
        logger.info(f"开始批量同步 {len(active_mccs)} 个MCC账号，日期: {target_date.isoformat()}")
        
        results = []
        total_saved = 0
        success_count = 0
        fail_count = 0
        quota_exhausted = False
        
        # 分批处理
        for i in range(0, len(active_mccs), batch_size):
            if quota_exhausted:
                logger.warning("检测到配额限制，停止后续MCC同步")
                break
            
            batch = active_mccs[i:i + batch_size]
            batch_num = i // batch_size + 1
            
            logger.info(f"处理第 {batch_num} 批，共 {len(batch)} 个MCC")
            
            for mcc in batch:
                try:
                    result = self.sync_mcc_data(
                        mcc.id,
                        target_date,
                        force_refresh=force_refresh,
                        only_enabled=only_enabled
                    )
                    
                    results.append({
                        "mcc_id": mcc.mcc_id,
                        "mcc_name": mcc.mcc_name,
                        "result": result
                    })
                    
                    if result.get("success"):
                        success_count += 1
                        total_saved += result.get("saved_count", 0)
                    else:
                        fail_count += 1
                        if result.get("quota_exhausted"):
                            quota_exhausted = True
                            break
                            
                except Exception as e:
                    fail_count += 1
                    results.append({
                        "mcc_id": mcc.mcc_id,
                        "mcc_name": mcc.mcc_name,
                        "result": {"success": False, "message": str(e)}
                    })
                    logger.error(f"MCC {mcc.mcc_id} 同步异常: {e}")
            
            # 批次间延迟
            if i + batch_size < len(active_mccs) and not quota_exhausted:
                logger.info(f"批次间延迟 {batch_delay} 秒...")
                time.sleep(batch_delay)
        
        return {
            "success": True,
            "message": f"批量同步完成",
            "total_mccs": len(active_mccs),
            "success_count": success_count,
            "fail_count": fail_count,
            "total_saved": total_saved,
            "quota_exhausted": quota_exhausted,
            "date": target_date.isoformat(),
            "results": results
        }
    
    def sync_historical_data(
        self,
        mcc_id: int,
        begin_date: date,
        end_date: date,
        force_refresh: bool = False
    ) -> Dict:
        """
        同步指定MCC的历史数据
        
        Args:
            mcc_id: MCC账号ID
            begin_date: 开始日期
            end_date: 结束日期
            force_refresh: 是否强制刷新
            
        Returns:
            同步结果
        """
        if begin_date > end_date:
            return {"success": False, "message": "开始日期不能晚于结束日期"}
        
        total_days = (end_date - begin_date).days + 1
        
        logger.info(f"开始同步MCC {mcc_id} 的历史数据: {begin_date} ~ {end_date}，共 {total_days} 天")
        
        success_days = 0
        fail_days = 0
        total_saved = 0
        errors = []
        quota_exhausted = False
        
        current_date = begin_date
        while current_date <= end_date:
            if quota_exhausted:
                logger.warning(f"配额限制，停止同步剩余 {(end_date - current_date).days + 1} 天")
                break
            
            try:
                result = self.sync_mcc_data(
                    mcc_id,
                    current_date,
                    force_refresh=force_refresh
                )
                
                if result.get("success"):
                    success_days += 1
                    total_saved += result.get("saved_count", 0)
                else:
                    fail_days += 1
                    errors.append(f"{current_date}: {result.get('message')}")
                    if result.get("quota_exhausted"):
                        quota_exhausted = True
                        
            except Exception as e:
                fail_days += 1
                errors.append(f"{current_date}: {str(e)}")
            
            current_date += timedelta(days=1)
            
            # 每天同步后延迟
            if current_date <= end_date and not quota_exhausted:
                time.sleep(settings.google_ads_request_delay_seconds)
        
        return {
            "success": True,
            "message": f"历史数据同步完成",
            "total_days": total_days,
            "success_days": success_days,
            "fail_days": fail_days,
            "total_saved": total_saved,
            "quota_exhausted": quota_exhausted,
            "errors": errors[:10]  # 只返回前10个错误
        }
    
    def test_connection(self, mcc_id: int) -> Dict:
        """
        测试MCC连接
        
        Args:
            mcc_id: MCC账号ID
            
        Returns:
            测试结果
        """
        mcc_account = self.db.query(GoogleMccAccount).filter(
            GoogleMccAccount.id == mcc_id
        ).first()
        
        if not mcc_account:
            return {"success": False, "message": "MCC账号不存在"}
        
        try:
            client, mcc_customer_id = self._create_client(mcc_account)
            customers = self.get_accessible_customers(client, mcc_customer_id)
            
            return {
                "success": True,
                "message": f"连接成功，找到 {len(customers)} 个客户账号",
                "customers_count": len(customers),
                "customers": customers[:5]  # 只返回前5个
            }
            
        except Exception as e:
            return {
                "success": False,
                "message": f"连接失败: {str(e)}"
            }
    
    def get_campaign_budget(
        self,
        client,
        customer_id: str,
        campaign_id: str
    ) -> Dict:
        """
        获取广告系列的预算信息
        """
        try:
            ga_service = client.get_service("GoogleAdsService")
            
            query = f"""
                SELECT
                    campaign.id,
                    campaign.name,
                    campaign_budget.id,
                    campaign_budget.amount_micros,
                    campaign_budget.delivery_method
                FROM campaign
                WHERE campaign.id = {campaign_id}
            """
            
            response = ga_service.search(customer_id=customer_id, query=query)
            
            for row in response:
                budget_micros = row.campaign_budget.amount_micros or 0
                return {
                    "success": True,
                    "campaign_id": str(row.campaign.id),
                    "campaign_name": row.campaign.name,
                    "budget_id": str(row.campaign_budget.id),
                    "daily_budget": budget_micros / 1_000_000,
                    "daily_budget_micros": budget_micros
                }
            
            return {"success": False, "message": "未找到广告系列"}
            
        except Exception as e:
            logger.error(f"获取广告系列 {campaign_id} 预算失败: {e}")
            return {"success": False, "message": str(e)}
    
    def set_campaign_budget(
        self,
        client,
        customer_id: str,
        budget_id: str,
        new_budget_micros: int
    ) -> Dict:
        """
        设置广告系列的每日预算
        
        Args:
            client: Google Ads客户端
            customer_id: 客户ID
            budget_id: 预算ID（从get_campaign_budget获取）
            new_budget_micros: 新预算（微单位）
        """
        from google.protobuf import field_mask_pb2
        
        try:
            budget_service = client.get_service("CampaignBudgetService")
            
            # 构建预算资源名称
            budget_resource = f"customers/{customer_id}/campaignBudgets/{budget_id}"
            
            # 创建预算对象
            budget = client.get_type("CampaignBudget")
            budget.resource_name = budget_resource
            budget.amount_micros = new_budget_micros
            
            # 创建更新操作
            operation = client.get_type("CampaignBudgetOperation")
            operation.update.CopyFrom(budget)
            operation.update_mask.CopyFrom(
                field_mask_pb2.FieldMask(paths=["amount_micros"])
            )
            
            # 执行更新
            response = budget_service.mutate_campaign_budgets(
                customer_id=customer_id,
                operations=[operation]
            )
            
            new_budget = new_budget_micros / 1_000_000
            logger.info(f"预算 {budget_id} 已设置为 ${new_budget}")
            
            return {
                "success": True,
                "message": f"每日预算已设置为 ${new_budget:.2f}",
                "resource_name": response.results[0].resource_name
            }
            
        except Exception as e:
            logger.error(f"设置预算 {budget_id} 失败: {e}")
            return {"success": False, "message": str(e)}

