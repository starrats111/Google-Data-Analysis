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
    # 操作指令相关参数（员工手动输入，全局默认值）
    past_seven_days_orders_global: Optional[float] = None  # 过去七天出单天数（全局默认值）
    max_cpc_global: Optional[float] = None  # 最高CPC（全局默认值）


class AnalysisResultResponse(BaseModel):
    id: int
    user_id: int
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


