"""
数据模型
"""
from app.models.user import User, UserRole
from app.models.affiliate_account import AffiliatePlatform, AffiliateAccount
from app.models.data_upload import DataUpload, UploadType, UploadStatus
from app.models.analysis_result import AnalysisResult
from app.models.ad_campaign import AdCampaign
from app.models.ad_campaign_daily_metric import AdCampaignDailyMetric
from app.models.expense_adjustment import ExpenseAdjustment
from app.models.mcc_cost_adjustment import MccCostAdjustment
from app.models.platform_data import PlatformData
from app.models.google_ads_api_data import GoogleAdsApiData, GoogleMccAccount, CampaignPlatformMapping
from app.models.affiliate_transaction import AffiliateTransaction, AffiliateRejection

__all__ = [
    "User",
    "UserRole",
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
    "AffiliateTransaction",
    "AffiliateRejection",
]








