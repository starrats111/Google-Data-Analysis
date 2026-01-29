"""
广告系列Schema
"""
from typing import Optional, List
from pydantic import BaseModel, Field
from datetime import datetime, date


class AdCampaignBase(BaseModel):
    """广告系列基础Schema"""
    cid_account: Optional[str] = None
    url: Optional[str] = None
    merchant_id: str
    country: Optional[str] = None
    campaign_name: str
    ad_time: Optional[str] = None
    keywords: Optional[str] = None
    status: str = "启用"  # 启用/暂停


class AdCampaignCreate(AdCampaignBase):
    """创建广告系列"""
    affiliate_account_id: int
    platform_id: int


class AdCampaignUpdate(BaseModel):
    """更新广告系列"""
    cid_account: Optional[str] = None
    url: Optional[str] = None
    merchant_id: Optional[str] = None
    country: Optional[str] = None
    campaign_name: Optional[str] = None
    ad_time: Optional[str] = None
    keywords: Optional[str] = None
    status: Optional[str] = None


class AdCampaignResponse(AdCampaignBase):
    """广告系列响应"""
    id: int
    user_id: int
    affiliate_account_id: int
    platform_id: int
    created_at: datetime
    updated_at: Optional[datetime] = None

    # 可选：某一天的每日指标（通过 /api/ad-campaigns?metrics_date=YYYY-MM-DD 拉取）
    metrics_date: Optional[str] = None
    daily_clicks: Optional[float] = None
    daily_orders: Optional[float] = None
    daily_budget: Optional[float] = None
    daily_cpc: Optional[float] = None
    daily_cost: Optional[float] = None
    daily_commission: Optional[float] = None
    daily_past_seven_days_order_days: Optional[float] = None
    daily_current_max_cpc: Optional[float] = None
    
    class Config:
        from_attributes = True


class AdCampaignBatchUpdate(BaseModel):
    """批量更新广告系列状态"""
    campaign_ids: List[int]
    status: str  # 启用/暂停


class AdCampaignImportRequest(BaseModel):
    """导入广告系列请求"""
    file_path: str
    affiliate_account_id: int
    platform_id: int

