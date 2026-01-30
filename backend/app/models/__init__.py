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
from app.models.google_ads_daily_data import GoogleAdsDailyData
from app.models.platform_daily_data import PlatformDailyData
from app.models.campaign_match_rule import CampaignMatchRule
from app.models.mcc_account import MccAccount

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
    "GoogleAdsDailyData",
    "PlatformDailyData",
    "CampaignMatchRule",
    "MccAccount",
]








