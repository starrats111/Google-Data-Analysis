"""
用户相关的Pydantic模型
"""
from pydantic import BaseModel, EmailStr
from typing import Optional
from datetime import datetime
from app.models.user import UserRole


class UserBase(BaseModel):
    username: str
    role: UserRole


class UserCreate(UserBase):
    password: str
    employee_id: Optional[int] = None


class UserLogin(BaseModel):
    username: str
    password: str


class UserResponse(UserBase):
    id: int
    employee_id: Optional[int]
    created_at: datetime
    
    class Config:
        from_attributes = True
        use_enum_values = True


class Token(BaseModel):
    access_token: str
    token_type: str
    user: UserResponse

