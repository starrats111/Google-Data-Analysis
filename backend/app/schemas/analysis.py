"""
数据分析相关的Pydantic模型
"""
from pydantic import BaseModel
from typing import Optional, Dict, Any
from datetime import date, datetime


class AnalysisRequest(BaseModel):
    google_ads_upload_id: int
    affiliate_upload_id: int
    affiliate_account_id: Optional[int] = None
    # 分析类型：l7d（默认，过去7天口径） / daily（当日口径 + 本周对比）
    analysis_type: Optional[str] = "l7d"
    # 操作指令相关参数（员工手动输入，全局默认值）
    past_seven_days_orders_global: Optional[float] = None  # 过去七天出单天数（全局默认值）
    max_cpc_global: Optional[float] = None  # 最高CPC（全局默认值）


class DailyL7DRequest(BaseModel):
    """从每日指标表生成 L7D 分析的请求体"""
    affiliate_account_id: Optional[int] = None  # 可选：指定联盟账号
    end_date: Optional[str] = None  # 截止日期，YYYY-MM-DD；默认用今天

class AnalysisResultResponse(BaseModel):
    id: int
    user_id: int
    username: Optional[str] = None  # 用户名，用于经理查看员工数据
    affiliate_account_id: Optional[int]
    analysis_date: date
    result_data: Dict[str, Any]
    created_at: datetime
    
    class Config:
        from_attributes = True


class AnalysisSummary(BaseModel):
    total_rows: int
    date_range: Optional[Dict[str, str]] = None
    epc: Optional[Dict[str, float]] = None
    roi: Optional[Dict[str, Any]] = None


