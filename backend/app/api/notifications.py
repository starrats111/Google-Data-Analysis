"""
全局消息通知 API（OPT-001）
"""
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import and_, or_, select, func

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.notification import Notification

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


def _role_value(role) -> str:
    return getattr(role, "value", str(role))


def _visible_user_ids(db: Session, current_user: User):
    """返回当前用户有权查看的通知对应的 user_id 列表（用于 WHERE user_id IN (...)）。"""
    role_val = _role_value(current_user.role)
    if role_val == "manager":
        return None  # 全部
    if role_val == "leader":
        if current_user.team_id is None:
            return []  # 无组则看不到任何人的
        from app.models.user import User
        rows = db.query(User.id).filter(User.team_id == current_user.team_id).all()
        return [r[0] for r in rows]
    # member / employee
    return [current_user.id]


@router.get("", response_model=dict)
def list_notifications(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取通知列表（分页，按角色权限过滤）"""
    visible = _visible_user_ids(db, current_user)
    query = db.query(Notification)
    if visible is not None:
        if not visible:
            return {"items": [], "total": 0, "page": page, "page_size": page_size, "total_pages": 0}
        query = query.filter(Notification.user_id.in_(visible))
    query = query.order_by(Notification.created_at.desc())
    total = query.count()
    total_pages = (total + page_size - 1) // page_size if page_size else 0
    items = query.offset((page - 1) * page_size).limit(page_size).all()
    return {
        "items": [
            {
                "id": n.id,
                "user_id": n.user_id,
                "type": n.type,
                "title": n.title,
                "content": n.content or "",
                "is_read": n.is_read,
                "created_at": n.created_at.isoformat() if n.created_at else None,
            }
            for n in items
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
    }


@router.get("/unread-count", response_model=dict)
def get_unread_count(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取未读数量（铃铛角标）"""
    visible = _visible_user_ids(db, current_user)
    query = db.query(func.count(Notification.id)).filter(Notification.is_read == False)
    if visible is not None:
        if not visible:
            return {"count": 0}
        query = query.filter(Notification.user_id.in_(visible))
    count = query.scalar() or 0
    return {"count": count}


@router.put("/{notification_id}/read", status_code=204)
def mark_read(
    notification_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """标记单条为已读（仅限可见范围内的通知）"""
    visible = _visible_user_ids(db, current_user)
    n = db.query(Notification).filter(Notification.id == notification_id).first()
    if not n:
        raise HTTPException(status_code=404, detail="Notification not found")
    if visible is not None:
        if n.user_id not in visible:
            raise HTTPException(status_code=403, detail="Forbidden")
    n.is_read = True
    db.commit()
    return None


@router.put("/read-all", status_code=204)
def mark_read_all(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """全部标记已读（仅标记当前用户有权查看的通知）"""
    visible = _visible_user_ids(db, current_user)
    query = db.query(Notification).filter(Notification.is_read == False)
    if visible is not None:
        if not visible:
            return None
        query = query.filter(Notification.user_id.in_(visible))
    for n in query.all():
        n.is_read = True
    db.commit()
    return None
