"""
用户模型
"""
from sqlalchemy import Column, Integer, String, DateTime, Enum, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base
import enum


class UserRole(str, enum.Enum):
    """用户角色枚举"""
    MANAGER = "manager"    # 经理 - 查看所有数据，编辑/删除权限
    LEADER = "leader"      # 组长 - 查看本组数据，编辑/删除本组
    MEMBER = "member"      # 组员 - 仅查看自己数据
    EMPLOYEE = "employee"  # 保留兼容旧数据


class User(Base):
    __tablename__ = "users"
    
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    role = Column(Enum(UserRole), nullable=False, default=UserRole.MEMBER)
    team_id = Column(Integer, ForeignKey("teams.id"), nullable=True)  # 所属小组
    employee_id = Column(Integer, nullable=True)  # 保留兼容
    display_name = Column(String(50), nullable=True)  # 显示姓名（中文名）
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # 关系
    team = relationship("Team", back_populates="members", foreign_keys=[team_id])
    affiliate_accounts = relationship("AffiliateAccount", back_populates="user", cascade="all, delete-orphan")
    data_uploads = relationship("DataUpload", back_populates="user")
    analysis_results = relationship("AnalysisResult", back_populates="user")
    ad_campaigns = relationship("AdCampaign", back_populates="user", cascade="all, delete-orphan")
    expense_adjustments = relationship("ExpenseAdjustment", cascade="all, delete-orphan")
    mcc_accounts = relationship("GoogleMccAccount", back_populates="user", cascade="all, delete-orphan")
    platform_data = relationship("PlatformData", cascade="all, delete-orphan")
    google_ads_data = relationship("GoogleAdsApiData", cascade="all, delete-orphan")
    campaign_mappings = relationship("CampaignPlatformMapping", cascade="all, delete-orphan")
    
    @property
    def is_manager(self) -> bool:
        """是否为经理"""
        return self.role == UserRole.MANAGER
    
    @property
    def is_leader(self) -> bool:
        """是否为组长"""
        return self.role == UserRole.LEADER
    
    @property
    def is_member(self) -> bool:
        """是否为普通组员"""
        return self.role in (UserRole.MEMBER, UserRole.EMPLOYEE)








