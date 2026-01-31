"""
联盟交易数据Schema
"""
from typing import Optional, List
from datetime import datetime, date
from pydantic import BaseModel


class TransactionSummaryResponse(BaseModel):
    """交易汇总响应"""
    total_orders: int  # 订单数
    gmv: float  # 交易金额（GMV）
    approved_commission: float  # 已确认佣金
    rejected_commission: float  # 拒付佣金
    start_date: date
    end_date: date
    platform: Optional[str] = None


class RejectionDetailResponse(BaseModel):
    """拒付详情响应"""
    platform: str
    merchant: Optional[str]
    transaction_id: str
    transaction_time: datetime
    order_amount: float
    commission_amount: float
    reject_reason: Optional[str]
    reject_time: Optional[datetime]

