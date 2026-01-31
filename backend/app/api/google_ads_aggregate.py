"""
Google Ads聚合数据API
完全对齐Google Ads的统计口径，使用predefined date ranges
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, and_
from typing import Optional
from datetime import datetime, timedelta, date
from pydantic import BaseModel

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.google_ads_api_data import GoogleAdsApiData, GoogleMccAccount
from app.models.affiliate_transaction import AffiliateTransaction

router = APIRouter(prefix="/api/google-ads-aggregate", tags=["google-ads-aggregate"])


class DateRangeAggregateResponse(BaseModel):
    """日期范围聚合响应"""
    date_range_type: str  # past7days, thisWeek, thisMonth, custom
    date_range_label: str  # "过去 7 天", "本周", "本月", "自定义"
    begin_date: date
    end_date: date
    
    # Google Ads数据（聚合后的一行）
    google_ads_cost: float
    google_ads_impressions: int
    google_ads_clicks: int
    google_ads_cpc: float
    
    # 联盟数据（聚合后的一行）
    affiliate_commission: float  # 已确认佣金
    affiliate_rejected_commission: float  # 拒付佣金
    affiliate_orders: int  # 总订单数
    
    # 计算指标
    roi: float  # ROI = (已确认佣金 - 拒付佣金) / Google Ads成本
    net_commission: float  # 净佣金 = 已确认佣金 - 拒付佣金


def get_date_range_from_type(date_range_type: str) -> tuple[date, date, str]:
    """
    根据日期范围类型获取开始和结束日期
    
    完全对齐Google Ads的predefined date ranges
    
    Args:
        date_range_type: 日期范围类型
            - past7days: 过去7天（LAST_7_DAYS）
            - thisWeek: 本周（THIS_WEEK）
            - thisMonth: 本月（THIS_MONTH）
            - custom: 自定义（需要提供begin_date和end_date）
    
    Returns:
        (begin_date, end_date, label)
    """
    today = date.today()
    
    if date_range_type == "past7days":
        # 过去7天：从7天前到今天（包含今天）
        begin_date = today - timedelta(days=6)  # 包含今天，所以是6天前
        end_date = today
        return begin_date, end_date, "过去 7 天"
    
    elif date_range_type == "thisWeek":
        # 本周：从本周一开始到今天
        days_since_monday = today.weekday()  # 0=Monday, 6=Sunday
        begin_date = today - timedelta(days=days_since_monday)
        end_date = today
        return begin_date, end_date, "本周"
    
    elif date_range_type == "thisMonth":
        # 本月：从本月1号到今天
        begin_date = today.replace(day=1)
        end_date = today
        return begin_date, end_date, "本月"
    
    elif date_range_type == "today":
        begin_date = today
        end_date = today
        return begin_date, end_date, "今天"
    
    elif date_range_type == "yesterday":
        begin_date = today - timedelta(days=1)
        end_date = begin_date
        return begin_date, end_date, "昨天"
    
    else:
        raise HTTPException(status_code=400, detail=f"不支持的日期范围类型: {date_range_type}")


@router.get("/by-campaign")
async def get_campaign_data(
    date_range_type: str = Query(..., description="日期范围类型: past7days, thisWeek, thisMonth, today, yesterday, custom"),
    begin_date: Optional[str] = Query(None, description="自定义开始日期 YYYY-MM-DD（仅custom时使用）"),
    end_date: Optional[str] = Query(None, description="自定义结束日期 YYYY-MM-DD（仅custom时使用）"),
    mcc_id: Optional[int] = Query(None, description="MCC ID（可选）"),
    platform_code: Optional[str] = Query(None, description="平台代码（可选）"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    按广告系列分组获取数据
    
    返回格式：
    - 时间范围（x月x日-y月y日）
    - 广告系列
    - 预算
    - 费用
    - 展示次数
    - 点击次数
    - CPC
    - CTR
    - IS Budget丢失
    - IS Rank丢失
    """
    # 获取日期范围
    if date_range_type == "custom":
        if not begin_date or not end_date:
            raise HTTPException(status_code=400, detail="自定义日期范围需要提供begin_date和end_date")
        try:
            begin = datetime.strptime(begin_date, "%Y-%m-%d").date()
            end = datetime.strptime(end_date, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(status_code=400, detail="日期格式错误，应为 YYYY-MM-DD")
    else:
        begin, end, _ = get_date_range_from_type(date_range_type)
    
    # 按广告系列分组查询
    query = db.query(
        GoogleAdsApiData.campaign_id,
        GoogleAdsApiData.campaign_name,
        func.sum(GoogleAdsApiData.budget).label('total_budget'),
        func.sum(GoogleAdsApiData.cost).label('total_cost'),
        func.sum(GoogleAdsApiData.impressions).label('total_impressions'),
        func.sum(GoogleAdsApiData.clicks).label('total_clicks'),
        func.avg(GoogleAdsApiData.cpc).label('avg_cpc'),
        func.avg(GoogleAdsApiData.is_budget_lost).label('avg_is_budget_lost'),
        func.avg(GoogleAdsApiData.is_rank_lost).label('avg_is_rank_lost')
    ).filter(
        GoogleAdsApiData.user_id == current_user.id,
        GoogleAdsApiData.date >= begin,
        GoogleAdsApiData.date <= end
    ).group_by(
        GoogleAdsApiData.campaign_id,
        GoogleAdsApiData.campaign_name
    )
    
    # 权限检查
    if current_user.role == "employee":
        query = query.filter(GoogleAdsApiData.user_id == current_user.id)
    
    # 筛选条件
    if mcc_id:
        query = query.filter(GoogleAdsApiData.mcc_id == mcc_id)
    
    if platform_code:
        query = query.filter(GoogleAdsApiData.extracted_platform_code == platform_code)
    
    results = query.all()
    
    # 格式化日期范围显示
    begin_str = begin.strftime("%m月%d日")
    end_str = end.strftime("%m月%d日")
    date_range_display = f"{begin_str}-{end_str}"
    
    # 格式化数据
    campaign_data = []
    for row in results:
        total_impressions = float(row.total_impressions or 0)
        total_clicks = float(row.total_clicks or 0)
        ctr = (total_clicks / total_impressions * 100) if total_impressions > 0 else 0
        
        campaign_data.append({
            "date_range": date_range_display,
            "campaign_name": row.campaign_name,
            "campaign_id": row.campaign_id,
            "budget": round(float(row.total_budget or 0), 2),
            "cost": round(float(row.total_cost or 0), 2),
            "impressions": int(total_impressions),
            "clicks": int(total_clicks),
            "cpc": round(float(row.avg_cpc or 0), 4),
            "ctr": round(ctr, 2),
            "is_budget_lost": round(float(row.avg_is_budget_lost or 0), 2),
            "is_rank_lost": round(float(row.avg_is_rank_lost or 0), 2)
        })
    
    return {
        "begin_date": begin.strftime("%Y-%m-%d"),
        "end_date": end.strftime("%Y-%m-%d"),
        "date_range_display": date_range_display,
        "campaigns": campaign_data
    }


@router.get("", response_model=DateRangeAggregateResponse)
@router.get("/", response_model=DateRangeAggregateResponse)
async def get_date_range_aggregate(
    date_range_type: str = Query(..., description="日期范围类型: past7days, thisWeek, thisMonth, today, yesterday, custom"),
    begin_date: Optional[str] = Query(None, description="自定义开始日期 YYYY-MM-DD（仅custom时使用）"),
    end_date: Optional[str] = Query(None, description="自定义结束日期 YYYY-MM-DD（仅custom时使用）"),
    mcc_id: Optional[int] = Query(None, description="MCC ID（可选）"),
    platform_code: Optional[str] = Query(None, description="平台代码（可选）"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    获取日期范围级别的聚合数据
    
    完全对齐Google Ads的统计口径：
    - 不按天拆分
    - 直接返回时间范围级别的聚合结果
    - 一行数据，不是多行加总
    
    这是财务级口径，确保与Google Ads UI完全一致。
    """
    # 获取日期范围
    if date_range_type == "custom":
        if not begin_date or not end_date:
            raise HTTPException(status_code=400, detail="自定义日期范围需要提供begin_date和end_date")
        try:
            begin = datetime.strptime(begin_date, "%Y-%m-%d").date()
            end = datetime.strptime(end_date, "%Y-%m-%d").date()
            date_range_label = f"{begin_date} ~ {end_date}"
        except ValueError:
            raise HTTPException(status_code=400, detail="日期格式错误，应为 YYYY-MM-DD")
    else:
        begin, end, date_range_label = get_date_range_from_type(date_range_type)
    
    # ========== Google Ads数据聚合（不按天拆分，直接聚合）==========
    google_ads_query = db.query(
        func.sum(GoogleAdsApiData.cost).label('total_cost'),
        func.sum(GoogleAdsApiData.impressions).label('total_impressions'),
        func.sum(GoogleAdsApiData.clicks).label('total_clicks')
    ).join(
        GoogleMccAccount
    ).filter(
        GoogleAdsApiData.user_id == current_user.id,
        GoogleAdsApiData.date >= begin,
        GoogleAdsApiData.date <= end
    )
    
    # 权限检查
    if current_user.role == "employee":
        google_ads_query = google_ads_query.filter(GoogleAdsApiData.user_id == current_user.id)
    
    # 筛选条件
    if mcc_id:
        google_ads_query = google_ads_query.filter(GoogleAdsApiData.mcc_id == mcc_id)
    
    if platform_code:
        google_ads_query = google_ads_query.filter(GoogleAdsApiData.extracted_platform_code == platform_code)
    
    google_ads_result = google_ads_query.first()
    
    google_ads_cost = float(google_ads_result.total_cost or 0)
    google_ads_impressions = int(google_ads_result.total_impressions or 0)
    google_ads_clicks = int(google_ads_result.total_clicks or 0)
    google_ads_cpc = google_ads_cost / google_ads_clicks if google_ads_clicks > 0 else 0
    
    # ========== 联盟数据聚合（使用相同的时间窗口，不按天拆分）==========
    # 使用transaction_time >= begin的00:00:00，<= end的23:59:59
    begin_datetime = datetime.combine(begin, datetime.min.time())
    end_datetime = datetime.combine(end, datetime.max.time())
    
    # 基础查询条件
    base_filter = and_(
        AffiliateTransaction.transaction_time >= begin_datetime,
        AffiliateTransaction.transaction_time <= end_datetime
    )
    
    # 权限检查
    if current_user.role == "employee":
        base_filter = and_(base_filter, AffiliateTransaction.user_id == current_user.id)
    
    # 筛选条件
    if platform_code:
        base_filter = and_(base_filter, AffiliateTransaction.platform == platform_code)
    
    # 已确认佣金（status = approved）
    approved_query = db.query(
        func.sum(AffiliateTransaction.commission_amount).label('total_commission'),
        func.count(AffiliateTransaction.id).label('total_orders')
    ).filter(
        and_(base_filter, AffiliateTransaction.status == "approved")
    )
    approved_result = approved_query.first()
    affiliate_commission = float(approved_result.total_commission or 0)
    affiliate_orders = int(approved_result.total_orders or 0)
    
    # 拒付佣金（status = rejected）
    rejected_query = db.query(
        func.sum(AffiliateTransaction.commission_amount).label('rejected_commission')
    ).filter(
        and_(base_filter, AffiliateTransaction.status == "rejected")
    )
    rejected_result = rejected_query.first()
    affiliate_rejected_commission = float(rejected_result.rejected_commission or 0)
    
    # 计算ROI（使用聚合后的数据，不是逐日加总）
    net_commission = affiliate_commission - affiliate_rejected_commission
    roi = (net_commission / google_ads_cost * 100) if google_ads_cost > 0 else 0
    
    return {
        "date_range_type": date_range_type,
        "date_range_label": date_range_label,
        "begin_date": begin,
        "end_date": end,
        "google_ads_cost": round(google_ads_cost, 2),
        "google_ads_impressions": google_ads_impressions,
        "google_ads_clicks": google_ads_clicks,
        "google_ads_cpc": round(google_ads_cpc, 4),
        "affiliate_commission": round(affiliate_commission, 2),
        "affiliate_rejected_commission": round(affiliate_rejected_commission, 2),
        "affiliate_orders": affiliate_orders,
        "roi": round(roi, 2),
        "net_commission": round(net_commission, 2)
    }

