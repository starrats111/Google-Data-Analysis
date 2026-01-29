"""
我的费用 - Schemas
"""
from typing import List, Optional, Dict
from pydantic import BaseModel


class ExpenseAdjustmentUpsert(BaseModel):
    platform_id: int
    date: str  # YYYY-MM-DD
    rejected_commission: float = 0.0


class ExpensePlatformSummary(BaseModel):
    platform_id: int
    platform_name: str

    # 当天
    today_commission: float
    today_ad_cost: float
    today_rejected_commission: float
    today_net_profit: float

    # 区间累计
    range_commission: float
    range_ad_cost: float
    range_rejected_commission: float
    range_net_profit: float


class ExpenseTotals(BaseModel):
    total_commission: float
    total_ad_cost: float
    total_rejected_commission: float
    net_profit: float
    avg_daily_profit: float
    day_count: int


class ExpenseSummaryResponse(BaseModel):
    start_date: str
    end_date: str
    today_date: str

    platforms: List[ExpensePlatformSummary]
    totals: ExpenseTotals


class ExpenseDailyRow(BaseModel):
    date: str
    platform_id: int
    platform_name: str
    commission: float
    ad_cost: float
    rejected_commission: float
    net_profit: float


class ExpenseDailyResponse(BaseModel):
    start_date: str
    end_date: str
    rows: List[ExpenseDailyRow]


class ExpenseUserSummary(BaseModel):
    """按员工汇总"""
    user_id: int
    username: str
    total_commission: float
    total_ad_cost: float
    total_rejected_commission: float
    net_profit: float
    platforms: List[ExpensePlatformSummary]  # 该员工各平台的费用


class ExpenseManagerSummaryResponse(BaseModel):
    """经理查看所有员工的费用汇总"""
    start_date: str
    end_date: str
    today_date: str
    # 所有员工汇总
    totals: ExpenseTotals
    # 按员工汇总
    users: List[ExpenseUserSummary]


