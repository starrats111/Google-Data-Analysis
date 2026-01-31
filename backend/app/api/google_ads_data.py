"""
Google Ads数据API
用于查看和管理Google Ads API数据
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import Optional, List
from datetime import date, datetime
from pydantic import BaseModel

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.google_ads_api_data import GoogleAdsApiData, GoogleMccAccount

router = APIRouter(prefix="/api/google-ads-data", tags=["google-ads-data"])


class GoogleAdsDataResponse(BaseModel):
    """Google Ads数据响应"""
    id: int
    mcc_id: int
    mcc_name: str
    campaign_id: str
    campaign_name: str
    date: str
    extracted_platform_code: Optional[str]
    extracted_account_code: Optional[str]
    budget: float
    cost: float
    impressions: float
    clicks: float
    cpc: float
    is_budget_lost: float
    is_rank_lost: float
    last_sync_at: Optional[str]
    
    class Config:
        from_attributes = True


@router.get("/", response_model=List[GoogleAdsDataResponse])
async def get_google_ads_data(
    mcc_id: Optional[int] = Query(None, description="MCC ID"),
    platform_code: Optional[str] = Query(None, description="平台代码"),
    begin_date: Optional[str] = Query(None, description="开始日期 YYYY-MM-DD"),
    end_date: Optional[str] = Query(None, description="结束日期 YYYY-MM-DD"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    获取Google Ads数据
    
    支持按MCC、平台、日期范围筛选
    """
    query = db.query(GoogleAdsApiData).join(
        GoogleMccAccount
    ).filter(
        GoogleAdsApiData.user_id == current_user.id
    )
    
    # 权限检查：员工只能查看自己的数据
    if current_user.role == "employee":
        query = query.filter(GoogleAdsApiData.user_id == current_user.id)
    
    # 筛选条件
    if mcc_id:
        query = query.filter(GoogleAdsApiData.mcc_id == mcc_id)
    
    if platform_code:
        query = query.filter(GoogleAdsApiData.extracted_platform_code == platform_code)
    
    if begin_date:
        try:
            begin = datetime.strptime(begin_date, "%Y-%m-%d").date()
            query = query.filter(GoogleAdsApiData.date >= begin)
        except ValueError:
            raise HTTPException(status_code=400, detail="开始日期格式错误")
    
    if end_date:
        try:
            end = datetime.strptime(end_date, "%Y-%m-%d").date()
            query = query.filter(GoogleAdsApiData.date <= end)
        except ValueError:
            raise HTTPException(status_code=400, detail="结束日期格式错误")
    
    # 按日期倒序排列
    query = query.order_by(GoogleAdsApiData.date.desc(), GoogleAdsApiData.campaign_id)
    
    results = query.all()
    
    # 转换为响应格式
    response_data = []
    for item in results:
        mcc = item.mcc_account
        response_data.append({
            "id": item.id,
            "mcc_id": item.mcc_id,
            "mcc_name": mcc.mcc_name,
            "campaign_id": item.campaign_id,
            "campaign_name": item.campaign_name,
            "date": item.date.isoformat(),
            "extracted_platform_code": item.extracted_platform_code,
            "extracted_account_code": item.extracted_account_code,
            "budget": item.budget,
            "cost": item.cost,
            "impressions": item.impressions,
            "clicks": item.clicks,
            "cpc": item.cpc,
            "is_budget_lost": item.is_budget_lost,
            "is_rank_lost": item.is_rank_lost,
            "last_sync_at": item.last_sync_at.isoformat() if item.last_sync_at else None
        })
    
    return response_data


@router.get("/summary")
async def get_google_ads_data_summary(
    mcc_id: Optional[int] = Query(None, description="MCC ID"),
    platform_code: Optional[str] = Query(None, description="平台代码"),
    begin_date: Optional[str] = Query(..., description="开始日期 YYYY-MM-DD"),
    end_date: Optional[str] = Query(..., description="结束日期 YYYY-MM-DD"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    获取Google Ads数据汇总（聚合数据）
    
    返回指定时间范围内的总费用、总展示、总点击、平均CPC等汇总数据
    """
    from sqlalchemy import func
    
    query = db.query(GoogleAdsApiData).join(
        GoogleMccAccount
    ).filter(
        GoogleAdsApiData.user_id == current_user.id
    )
    
    # 权限检查：员工只能查看自己的数据
    if current_user.role == "employee":
        query = query.filter(GoogleAdsApiData.user_id == current_user.id)
    
    # 筛选条件
    if mcc_id:
        query = query.filter(GoogleAdsApiData.mcc_id == mcc_id)
    
    if platform_code:
        query = query.filter(GoogleAdsApiData.extracted_platform_code == platform_code)
    
    # 日期范围（必需）
    try:
        begin = datetime.strptime(begin_date, "%Y-%m-%d").date()
        end = datetime.strptime(end_date, "%Y-%m-%d").date()
        query = query.filter(
            GoogleAdsApiData.date >= begin,
            GoogleAdsApiData.date <= end
        )
    except ValueError:
        raise HTTPException(status_code=400, detail="日期格式错误，应为 YYYY-MM-DD")
    
    # 聚合查询
    result = db.query(
        func.sum(GoogleAdsApiData.cost).label('total_cost'),
        func.sum(GoogleAdsApiData.impressions).label('total_impressions'),
        func.sum(GoogleAdsApiData.clicks).label('total_clicks'),
        func.count(GoogleAdsApiData.id).label('record_count')
    ).join(
        GoogleMccAccount
    ).filter(
        GoogleAdsApiData.user_id == current_user.id,
        GoogleAdsApiData.date >= begin,
        GoogleAdsApiData.date <= end
    )
    
    if mcc_id:
        result = result.filter(GoogleAdsApiData.mcc_id == mcc_id)
    
    if platform_code:
        result = result.filter(GoogleAdsApiData.extracted_platform_code == platform_code)
    
    summary = result.first()
    
    total_cost = float(summary.total_cost or 0)
    total_impressions = int(summary.total_impressions or 0)
    total_clicks = int(summary.total_clicks or 0)
    record_count = int(summary.record_count or 0)
    avg_cpc = total_cost / total_clicks if total_clicks > 0 else 0
    
    return {
        "total_cost": total_cost,
        "total_impressions": total_impressions,
        "total_clicks": total_clicks,
        "avg_cpc": avg_cpc,
        "record_count": record_count,
        "date_range": {
            "begin_date": begin_date,
            "end_date": end_date
        }
    }


