"""
露出通知管理 API
"""
import logging
from typing import List
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import desc

from app.database import get_db
from app.models.user import User
from app.models.luchu import LuchuNotification
from app.schemas.luchu import NotificationResponse
from app.middleware.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/luchu/notifications", tags=["luchu-notifications"])


@router.get("", response_model=List[NotificationResponse])
async def list_notifications(
    unread_only: bool = Query(False, description="只显示未读"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取通知列表"""
    query = db.query(LuchuNotification).filter(
        LuchuNotification.user_id == current_user.id
    )
    
    if unread_only:
        query = query.filter(LuchuNotification.is_read == 0)
    
    query = query.order_by(desc(LuchuNotification.created_at))
    
    total = query.count()
    notifications = query.offset((page - 1) * page_size).limit(page_size).all()
    
    return [NotificationResponse(
        id=n.id,
        type=n.type,
        title=n.title,
        content=n.content,
        related_type=n.related_type,
        related_id=n.related_id,
        is_read=bool(n.is_read),
        created_at=n.created_at
    ) for n in notifications]


@router.get("/unread-count")
async def get_unread_count(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取未读通知数量"""
    from sqlalchemy import func
    
    count = db.query(func.count(LuchuNotification.id)).filter(
        LuchuNotification.user_id == current_user.id,
        LuchuNotification.is_read == 0
    ).scalar() or 0
    
    return {"count": count}


@router.post("/{notification_id}/read")
async def mark_as_read(
    notification_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """标记通知为已读"""
    notification = db.query(LuchuNotification).filter(
        LuchuNotification.id == notification_id,
        LuchuNotification.user_id == current_user.id
    ).first()
    
    if not notification:
        raise HTTPException(status_code=404, detail="通知不存在")
    
    notification.is_read = 1
    db.commit()
    
    return {"message": "已标记为已读"}


@router.post("/read-all")
async def mark_all_as_read(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """标记所有通知为已读"""
    db.query(LuchuNotification).filter(
        LuchuNotification.user_id == current_user.id,
        LuchuNotification.is_read == 0
    ).update({"is_read": 1})
    
    db.commit()
    
    return {"message": "已全部标记为已读"}

