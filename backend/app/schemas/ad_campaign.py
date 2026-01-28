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

