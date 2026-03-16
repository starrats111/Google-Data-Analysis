"""
数据模型
"""
from app.models.user import User, UserRole
from app.models.team import Team
from app.models.affiliate_account import AffiliatePlatform, AffiliateAccount
from app.models.data_upload import DataUpload, UploadType, UploadStatus
from app.models.analysis_result import AnalysisResult
from app.models.ad_campaign import AdCampaign
from app.models.ad_campaign_daily_metric import AdCampaignDailyMetric
from app.models.expense_adjustment import ExpenseAdjustment
from app.models.mcc_cost_adjustment import MccCostAdjustment
from app.models.platform_data import PlatformData
from app.models.google_ads_api_data import GoogleAdsApiData, GoogleMccAccount, CampaignPlatformMapping
from app.models.keyword_bid import CampaignBidStrategy
from app.models.affiliate_transaction import AffiliateTransaction, AffiliateRejection
from app.models.ai_report import AIReport, UserPrompt
from app.models.notification import Notification
from app.models.commission_snapshot import CommissionSnapshot
# 商家任务分配
from app.models.merchant import AffiliateMerchant, MerchantAssignment
from app.models.merchant_discovery_run import MerchantDiscoveryRun
from app.models.merchant_mid_repair_queue import MerchantMidRepairQueue
from app.models.merchant_alias import MerchantAlias
from app.models.platform_field_contract import PlatformFieldContract
from app.models.merchant_source_snapshot import MerchantSourceSnapshot
from app.models.merchant_assignment_event import MerchantAssignmentEvent
from app.models.merchant_account_relationship import MerchantAccountRelationship
# 文章发布系统（OPT-011）
from app.models.article import (
    PubArticle, PubCategory, PubTag, PubArticleTag,
    PubArticleLink, PubArticleImage, PubArticleTitle, PubArticleVersion,
)
# 追踪链接历史（OPT-012）
from app.models.tracking_link import PubTrackingLink
# 网站发布配置（OPT-013）
from app.models.site import PubSite
# 用户-网站绑定（CR-008）
from app.models.user_site_binding import UserSiteBinding
# Campaign Link 缓存（OPT-016）
from app.models.campaign_link_cache import CampaignLinkCache
# 违规上报 & 共享表格配置
from app.models.violation_report import ViolationReport
from app.models.sheet_config import SheetConfig

__all__ = [
    "User",
    "UserRole",
    "Team",
    "AffiliatePlatform",
    "AffiliateAccount",
    "DataUpload",
    "UploadType",
    "UploadStatus",
    "AnalysisResult",
    "AdCampaign",
    "AdCampaignDailyMetric",
    "ExpenseAdjustment",
    "MccCostAdjustment",
    "PlatformData",
    "GoogleAdsApiData",
    "GoogleMccAccount",
    "CampaignPlatformMapping",
    "CampaignBidStrategy",
    "AffiliateTransaction",
    "AffiliateRejection",
    "AIReport",
    "UserPrompt",
    "Notification",
    "CommissionSnapshot",
    # 商家任务分配
    "AffiliateMerchant",
    "MerchantAssignment",
    "MerchantDiscoveryRun",
    "MerchantMidRepairQueue",
    "MerchantAlias",
    "PlatformFieldContract",
    "MerchantSourceSnapshot",
    "MerchantAssignmentEvent",
    "MerchantAccountRelationship",
    # 文章发布系统
    "PubArticle",
    "PubCategory",
    "PubTag",
    "PubArticleTag",
    "PubArticleLink",
    "PubArticleImage",
    "PubArticleTitle",
    "PubArticleVersion",
    # 追踪链接历史
    "PubTrackingLink",
    # 网站发布配置
    "PubSite",
    # 用户-网站绑定
    "UserSiteBinding",
    # Campaign Link 缓存
    "CampaignLinkCache",
    # 违规上报 & 共享表格配置
    "ViolationReport",
    "SheetConfig",
]








