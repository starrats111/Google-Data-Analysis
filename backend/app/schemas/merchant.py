"""
商家目录与任务分配 Pydantic 模型
"""
from pydantic import BaseModel
from typing import Optional
from datetime import datetime


# ------------------------------------------------------------------
# 商家
# ------------------------------------------------------------------

class MerchantUpdate(BaseModel):
    category: Optional[str] = None
    commission_rate: Optional[str] = None
    logo_url: Optional[str] = None
    status: Optional[str] = None
    notes: Optional[str] = None
    slug: Optional[str] = None
    merchant_id: Optional[str] = None


# ------------------------------------------------------------------
# 分配
# ------------------------------------------------------------------

class AssignmentCreate(BaseModel):
    merchant_ids: list[int]
    user_id: int
    priority: str = "normal"
    monthly_target: Optional[float] = None
    notes: Optional[str] = None


class AssignmentUpdate(BaseModel):
    priority: Optional[str] = None
    monthly_target: Optional[float] = None
    notes: Optional[str] = None
    status: Optional[str] = None


class AssignmentTransfer(BaseModel):
    assignment_ids: list[int]
    new_user_id: int
