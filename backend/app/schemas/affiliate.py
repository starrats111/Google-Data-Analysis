"""
联盟账号相关的Pydantic模型
"""
from pydantic import BaseModel, EmailStr
from typing import Optional
from datetime import datetime


class AffiliatePlatformBase(BaseModel):
    platform_name: str
    platform_code: str
    description: Optional[str] = None


class AffiliatePlatformCreate(AffiliatePlatformBase):
    pass


class AffiliatePlatformResponse(AffiliatePlatformBase):
    id: int
    created_at: datetime
    
    class Config:
        from_attributes = True


class AffiliateAccountBase(BaseModel):
    platform_id: int
    account_name: str
    account_code: Optional[str] = None
    email: Optional[EmailStr] = None  # 邮箱地址
    is_active: bool = True
    notes: Optional[str] = None
    payee_name: Optional[str] = None  # 收款人
    payee_card: Optional[str] = None  # 收款卡号


class AffiliateAccountCreate(AffiliateAccountBase):
    pass


class AffiliateAccountUpdate(BaseModel):
    account_name: Optional[str] = None
    account_code: Optional[str] = None
    email: Optional[EmailStr] = None  # 邮箱地址
    is_active: Optional[bool] = None
    notes: Optional[str] = None
    payee_name: Optional[str] = None  # 收款人
    payee_card: Optional[str] = None  # 收款卡号


class AffiliateAccountResponse(AffiliateAccountBase):
    id: int
    user_id: int
    platform: AffiliatePlatformResponse
    created_at: datetime
    updated_at: Optional[datetime]
    payee_name: Optional[str] = None
    payee_card: Optional[str] = None
    
    class Config:
        from_attributes = True


