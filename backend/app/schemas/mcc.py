"""
MCC账号相关的Pydantic模型
"""
from pydantic import BaseModel, EmailStr
from typing import Optional
from datetime import datetime


class MccAccountBase(BaseModel):
    mcc_account_id: str
    mcc_account_name: Optional[str] = None
    email: Optional[EmailStr] = None
    refresh_token: str
    client_id: str
    client_secret: str
    developer_token: str
    is_active: bool = True


class MccAccountCreate(BaseModel):
    mcc_account_id: str
    mcc_account_name: Optional[str] = None
    email: Optional[EmailStr] = None
    refresh_token: str
    # 以下字段可选（如果配置了共享配置，则不需要填写）
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    developer_token: Optional[str] = None
    is_active: bool = True


class MccAccountUpdate(BaseModel):
    mcc_account_name: Optional[str] = None
    email: Optional[EmailStr] = None
    refresh_token: Optional[str] = None
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    developer_token: Optional[str] = None
    is_active: Optional[bool] = None


class MccAccountResponse(MccAccountBase):
    id: int
    user_id: int
    created_at: datetime
    updated_at: Optional[datetime]
    
    class Config:
        from_attributes = True


class TestConnectionResponse(BaseModel):
    success: bool
    message: str
    data: Optional[dict] = None

