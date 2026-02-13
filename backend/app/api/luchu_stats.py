"""
露出统计数据 API
"""
import logging
from datetime import datetime, timedelta
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func, desc

from app.database import get_db
from app.models.user import User
from app.models.luchu import (
    LuchuArticle, LuchuNotification, LuchuImageAlert
)
from app.schemas.luchu import LuchuDashboardStats, LuchuPublishTrend
from app.middleware.auth import get_current_user, get_luchu_authorized_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/luchu/stats", tags=["luchu-stats"])


@router.get("/dashboard", response_model=LuchuDashboardStats)
async def get_dashboard_stats(
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """获取仪表盘统计数据"""
    
    # 我的文章数
    my_articles_query = db.query(func.count(LuchuArticle.id)).filter(
        LuchuArticle.author_id == current_user.id
    )
    my_articles = my_articles_query.scalar() or 0
    
    # 待审核数（仅管理员/组长可见全部）
    if current_user.role in ['manager', 'leader']:
        pending_review = db.query(func.count(LuchuArticle.id)).filter(
            LuchuArticle.status == "pending"
        ).scalar() or 0
    else:
        pending_review = 0
    
    # 待发布数（自己的文章）
    ready_to_publish = db.query(func.count(LuchuArticle.id)).filter(
        LuchuArticle.author_id == current_user.id,
        LuchuArticle.status == "ready"
    ).scalar() or 0
    
    # 总发布数
    if current_user.role in ['manager', 'leader']:
        total_published = db.query(func.count(LuchuArticle.id)).filter(
            LuchuArticle.status == "published"
        ).scalar() or 0
    else:
        total_published = db.query(func.count(LuchuArticle.id)).filter(
            LuchuArticle.author_id == current_user.id,
            LuchuArticle.status == "published"
        ).scalar() or 0
    
    # 未读通知数
    unread_notifications = db.query(func.count(LuchuNotification.id)).filter(
        LuchuNotification.user_id == current_user.id,
        LuchuNotification.is_read == 0
    ).scalar() or 0
    
    # 图片告警数（自己的文章）
    image_alerts = db.query(func.count(LuchuImageAlert.id)).filter(
        LuchuImageAlert.user_id == current_user.id,
        LuchuImageAlert.is_resolved == 0
    ).scalar() or 0
    
    return LuchuDashboardStats(
        my_articles=my_articles,
        pending_review=pending_review,
        ready_to_publish=ready_to_publish,
        total_published=total_published,
        unread_notifications=unread_notifications,
        image_alerts=image_alerts
    )


@router.get("/publish-trend", response_model=List[LuchuPublishTrend])
async def get_publish_trend(
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """获取本月发布趋势"""
    # 获取本月第一天
    today = datetime.now()
    first_day = today.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    
    # 按日期统计发布数
    query = db.query(
        func.date(LuchuArticle.published_at).label('date'),
        func.count(LuchuArticle.id).label('count')
    ).filter(
        LuchuArticle.status == "published",
        LuchuArticle.published_at >= first_day
    )
    
    # 普通用户只统计自己的
    if current_user.role not in ['manager', 'leader']:
        query = query.filter(LuchuArticle.author_id == current_user.id)
    
    query = query.group_by(func.date(LuchuArticle.published_at))
    query = query.order_by(func.date(LuchuArticle.published_at))
    
    results = query.all()
    
    return [LuchuPublishTrend(
        date=str(r.date),
        count=r.count
    ) for r in results]


@router.get("/category-stats")
async def get_category_stats(
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """获取按分类统计"""
    query = db.query(
        LuchuArticle.category,
        LuchuArticle.category_name,
        func.count(LuchuArticle.id).label('count')
    ).filter(
        LuchuArticle.status == "published"
    )
    
    # 普通用户只统计自己的
    if current_user.role not in ['manager', 'leader']:
        query = query.filter(LuchuArticle.author_id == current_user.id)
    
    query = query.group_by(LuchuArticle.category, LuchuArticle.category_name)
    query = query.order_by(desc(func.count(LuchuArticle.id)))
    
    results = query.all()
    
    return [{
        "category": r.category or "other",
        "categoryName": r.category_name or "其他",
        "count": r.count
    } for r in results]


@router.get("/review-efficiency")
async def get_review_efficiency(
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """获取审核效率统计（仅管理员/组长）"""
    if current_user.role not in ['manager', 'leader']:
        raise HTTPException(status_code=403, detail="无权访问")
    
    from app.models.luchu import LuchuReview
    
    # 本月审核数据
    today = datetime.now()
    first_day = today.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    
    # 审核总数
    total_reviews = db.query(func.count(LuchuReview.id)).filter(
        LuchuReview.created_at >= first_day
    ).scalar() or 0
    
    # 通过数
    approved = db.query(func.count(LuchuReview.id)).filter(
        LuchuReview.created_at >= first_day,
        LuchuReview.status == "approved"
    ).scalar() or 0
    
    # 驳回数
    rejected = db.query(func.count(LuchuReview.id)).filter(
        LuchuReview.created_at >= first_day,
        LuchuReview.status == "rejected"
    ).scalar() or 0
    
    # 通过率
    pass_rate = (approved / total_reviews * 100) if total_reviews > 0 else 0
    
    return {
        "total_reviews": total_reviews,
        "approved": approved,
        "rejected": rejected,
        "pass_rate": round(pass_rate, 1)
    }

