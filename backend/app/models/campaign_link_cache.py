"""
Campaign Link 本地缓存模型（OPT-016 / CR-037）

每个用户 × 每个平台 × 每个商家 MID 缓存一条 campaign link 记录，
包含 tracking_url、support_regions 等完整信息，每天 05:00 全量刷新。
"""
from datetime import datetime

from sqlalchemy import Column, Integer, String, Text, DateTime, Index
from app.database import Base


class CampaignLinkCache(Base):
    __tablename__ = "campaign_link_cache"

    id = Column(Integer, primary_key=True, autoincrement=True)

    user_id = Column(Integer, nullable=False, index=True)
    platform_code = Column(String(10), nullable=False, index=True)
    merchant_id = Column(String(100), nullable=False, index=True)

    # 核心字段
    campaign_link = Column(Text, nullable=True)
    short_link = Column(Text, nullable=True)
    smart_link = Column(Text, nullable=True)
    site_url = Column(Text, nullable=True)
    merchant_name = Column(String(200), nullable=True)

    # support_regions: JSON 字符串，如 [{"code":"US","language":"English","language_code":"en"}, ...]
    support_regions = Column(Text, nullable=True)

    categories = Column(Text, nullable=True)
    commission_rate = Column(String(100), nullable=True)
    logo = Column(Text, nullable=True)
    mcid = Column(String(200), nullable=True, index=True)  # 平台 MCID/slug 标识

    synced_at = Column(DateTime, default=datetime.utcnow)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index("ix_clc_user_platform_mid", "user_id", "platform_code", "merchant_id", unique=True),
    )

    def __repr__(self):
        return f"<CampaignLinkCache user={self.user_id} {self.platform_code}/{self.merchant_id}>"
