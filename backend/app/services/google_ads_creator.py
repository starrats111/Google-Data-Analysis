"""
Google Ads 广告创建服务（CR-039 / CR-048）
使用打包 Mutate 一次 API 调用创建完整广告结构：
Campaign → AdGroup → AdGroupAd (RSA) → AdGroupCriterion (Keywords) → CampaignAsset (Sitelinks)
"""
import logging
from datetime import datetime
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.google_ads_api_data import GoogleMccAccount
from app.services.google_ads_client_factory import create_google_ads_client

logger = logging.getLogger(__name__)


def _get_ad_defaults() -> dict:
    """读取广告默认设置"""
    from app.api.merchants import _load_ad_defaults
    return _load_ad_defaults()


class GoogleAdsCreator:
    """Google Ads 广告创建器"""

    def __init__(self, db: Session):
        self.db = db

    def create_full_campaign(
        self,
        mcc_id: int,
        customer_id: str,
        merchant_name: str,
        keywords: List[str],
        headlines: List[str],
        descriptions: List[str],
        daily_budget: float = 10.0,
        target_country: str = "US",
        mode: str = "test",
        final_url: str = "",
    ) -> Dict:
        """一次 API 调用创建完整广告结构。

        M-49 闭环：
        - 打包 Mutate 是原子操作（全成功或全失败），无需回滚
        - 幂等性：创建前检查同名广告系列是否已存在
        - 错误处理：QUOTA_EXCEEDED / AUTHENTICATION_ERROR / 超时
        """
        mcc = self.db.query(GoogleMccAccount).filter(GoogleMccAccount.id == mcc_id).first()
        if not mcc:
            raise ValueError("MCC 账号不存在")

        client, mcc_customer_id = create_google_ads_client(mcc)
        cid = customer_id.replace("-", "")

        # 幂等性检查：同名广告系列是否已存在
        date_str = datetime.now().strftime("%Y%m%d")
        campaign_name = f"{merchant_name}_{mode}_{date_str}"
        existing = self._check_existing_campaign(client, cid, campaign_name)
        if existing:
            return {
                "success": True,
                "campaign_id": existing,
                "campaign_name": campaign_name,
                "message": "该商家今日已创建过广告，返回已有广告系列",
                "is_existing": True,
            }

        # 构建打包 Mutate 操作
        try:
            operations = self._build_mutate_operations(
                client, cid, campaign_name,
                keywords, headlines, descriptions,
                daily_budget, target_country, final_url,
            )

            # 执行打包 Mutate（原子操作）
            service = client.get_service("GoogleAdsService")
            response = service.mutate(customer_id=cid, mutate_operations=operations)

            # 提取创建的资源 ID
            campaign_id = None
            for result in response.mutate_operation_responses:
                if result.campaign_result.resource_name:
                    campaign_id = result.campaign_result.resource_name.split("/")[-1]
                    break

            logger.info(f"[AdsCreator] 广告创建成功: campaign={campaign_name}, id={campaign_id}")
            return {
                "success": True,
                "campaign_id": campaign_id,
                "campaign_name": campaign_name,
                "message": "广告创建成功",
                "is_existing": False,
            }

        except Exception as e:
            error_msg = str(e)
            logger.error(f"[AdsCreator] 广告创建失败: {e}")

            failure_details = []
            if hasattr(e, 'failure') and e.failure:
                for err in e.failure.errors:
                    failure_details.append(f"{err.error_code}: {err.message}")
            detail_str = "; ".join(failure_details) if failure_details else ""

            if "QUOTA_EXCEEDED" in error_msg or "RESOURCE_EXHAUSTED" in error_msg:
                raise ValueError("今日 API 额度已用完，请明天再试")
            if "AUTHENTICATION_ERROR" in error_msg or "AuthenticationError" in error_msg:
                raise ValueError("MCC 认证失败，请检查服务账号配置")
            if "ALREADY_EXISTS" in error_msg:
                raise ValueError("广告系列已存在，请勿重复创建")
            if "DEVELOPER_TOKEN" in error_msg:
                raise ValueError("开发者令牌未审批，请使用测试 MCC 或申请正式令牌")
            if detail_str:
                raise ValueError(f"广告创建失败: {detail_str}")
            raise ValueError(f"广告创建失败: {error_msg[:300]}")

    def _check_existing_campaign(self, client, customer_id: str, campaign_name: str) -> Optional[str]:
        """检查同名广告系列是否已存在"""
        try:
            ga_service = client.get_service("GoogleAdsService")
            query = f"""
                SELECT campaign.id, campaign.name
                FROM campaign
                WHERE campaign.name = '{campaign_name}'
                LIMIT 1
            """
            response = ga_service.search(customer_id=customer_id, query=query)
            for row in response:
                return str(row.campaign.id)
        except Exception:
            pass
        return None

    def _build_mutate_operations(
        self, client, customer_id: str, campaign_name: str,
        keywords: List[str], headlines: List[str], descriptions: List[str],
        daily_budget: float, target_country: str, final_url: str,
    ) -> list:
        """构建打包 Mutate 操作列表（使用临时 ID + 读取默认设置）"""
        defaults = _get_ad_defaults()
        operations = []

        BUDGET_TEMP_ID = -1
        CAMPAIGN_TEMP_ID = -2
        AD_GROUP_TEMP_ID = -3

        # 1. CampaignBudget
        budget_op = client.get_type("MutateOperation")
        budget = budget_op.campaign_budget_operation.create
        budget.name = f"{campaign_name}_budget"
        budget.amount_micros = int(daily_budget * 1_000_000)
        budget.delivery_method = client.enums.BudgetDeliveryMethodEnum.STANDARD
        budget.resource_name = client.get_service("CampaignBudgetService").campaign_budget_path(
            customer_id, str(BUDGET_TEMP_ID)
        )
        operations.append(budget_op)

        # 2. Campaign（使用默认设置）
        campaign_op = client.get_type("MutateOperation")
        campaign = campaign_op.campaign_operation.create
        campaign.name = campaign_name
        campaign.advertising_channel_type = client.enums.AdvertisingChannelTypeEnum.SEARCH
        campaign.status = client.enums.CampaignStatusEnum.PAUSED
        campaign.campaign_budget = client.get_service("CampaignBudgetService").campaign_budget_path(
            customer_id, str(BUDGET_TEMP_ID)
        )
        campaign.resource_name = client.get_service("CampaignService").campaign_path(
            customer_id, str(CAMPAIGN_TEMP_ID)
        )

        bidding = defaults.get("bidding_strategy", "MANUAL_CPC")
        if bidding == "MAXIMIZE_CLICKS":
            campaign.maximize_clicks.cpc_bid_ceiling_micros = int(defaults.get("default_cpc_bid", 2.0) * 1_000_000)
        else:
            # protobuf3 oneof: setting bool to False (default) won't populate the oneof,
            # so set True first to force populate, then set the desired value
            campaign.manual_cpc.enhanced_cpc_enabled = True
            if not defaults.get("enhanced_cpc", True):
                campaign.manual_cpc.enhanced_cpc_enabled = False

        campaign.network_settings.target_google_search = defaults.get("target_google_search", True)
        campaign.network_settings.target_search_network = defaults.get("target_search_network", False)
        campaign.network_settings.target_content_network = defaults.get("target_content_network", False)

        # 投放地区
        campaign_geo_op = client.get_type("MutateOperation")
        geo_target = campaign_geo_op.campaign_criterion_operation.create
        geo_target.campaign = client.get_service("CampaignService").campaign_path(
            customer_id, str(CAMPAIGN_TEMP_ID)
        )
        geo_country_map = {
            "US": "2840", "UK": "2826", "CA": "2124", "AU": "2036",
            "DE": "2276", "FR": "2250", "JP": "2392", "BR": "2076",
        }
        geo_id = geo_country_map.get(target_country, "2840")
        geo_target.location.geo_target_constant = f"geoTargetConstants/{geo_id}"
        operations.append(campaign_op)
        operations.append(campaign_geo_op)

        # 3. AdGroup
        ad_group_op = client.get_type("MutateOperation")
        ad_group = ad_group_op.ad_group_operation.create
        ad_group.name = f"{campaign_name}_adgroup"
        ad_group.campaign = client.get_service("CampaignService").campaign_path(
            customer_id, str(CAMPAIGN_TEMP_ID)
        )
        ad_group.type_ = client.enums.AdGroupTypeEnum.SEARCH_STANDARD
        ad_group.cpc_bid_micros = int(defaults.get("default_cpc_bid", 1.0) * 1_000_000)
        ad_group.resource_name = client.get_service("AdGroupService").ad_group_path(
            customer_id, str(AD_GROUP_TEMP_ID)
        )
        operations.append(ad_group_op)

        # 4. AdGroupAd (RSA)
        ad_op = client.get_type("MutateOperation")
        ad_group_ad = ad_op.ad_group_ad_operation.create
        ad_group_ad.ad_group = client.get_service("AdGroupService").ad_group_path(
            customer_id, str(AD_GROUP_TEMP_ID)
        )
        ad_group_ad.status = client.enums.AdGroupAdStatusEnum.ENABLED
        rsa = ad_group_ad.ad.responsive_search_ad
        for h in headlines[:15]:
            headline = client.get_type("AdTextAsset")
            headline.text = h[:30]
            rsa.headlines.append(headline)
        for d in descriptions[:4]:
            desc = client.get_type("AdTextAsset")
            desc.text = d[:90]
            rsa.descriptions.append(desc)
        resolved_url = final_url or "https://example.com"
        ad_group_ad.ad.final_urls.append(resolved_url)
        operations.append(ad_op)

        # 5. AdGroupCriterion (Keywords) — 批量添加
        for kw in keywords[:20]:
            kw_op = client.get_type("MutateOperation")
            criterion = kw_op.ad_group_criterion_operation.create
            criterion.ad_group = client.get_service("AdGroupService").ad_group_path(
                customer_id, str(AD_GROUP_TEMP_ID)
            )
            criterion.keyword.text = kw
            criterion.keyword.match_type = client.enums.KeywordMatchTypeEnum.BROAD
            operations.append(kw_op)

        logger.info(f"[AdsCreator] 构建 {len(operations)} 个 Mutate 操作 (campaign={campaign_name})")
        return operations
