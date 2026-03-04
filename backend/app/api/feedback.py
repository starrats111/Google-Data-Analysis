"""
用户反馈 API
所有用户可提交反馈，统一投递给维护人员 wj07；wj07 可查看与回复。
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import desc

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.notification import Notification

router = APIRouter(prefix="/api/feedback", tags=["feedback"])

FEEDBACK_TYPE_MAP = {
    "data_issue": "数据误差",
    "feature_experience": "功能体验",
    "bug_report": "功能异常",
    "feature_request": "功能建议",
    "other": "其他",
}


def _role_value(role) -> str:
    return getattr(role, "value", str(role))


def _is_feedback_manager(user: User) -> bool:
    """wj07 或 manager 可管理反馈"""
    return user.username == "wj07" or _role_value(user.role) == "manager"


class FeedbackCreate(BaseModel):
    feedback_type: str = Field(default="other", max_length=50)
    subject: Optional[str] = Field(default=None, max_length=120)
    content: str = Field(min_length=5, max_length=3000)
    page_path: Optional[str] = Field(default=None, max_length=300)


class FeedbackReply(BaseModel):
    content: str = Field(min_length=1, max_length=3000)


@router.post("")
async def submit_feedback(
    payload: FeedbackCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    maintainer = db.query(User).filter(User.username == "wj07").first()
    if not maintainer:
        raise HTTPException(status_code=500, detail="维护人员账号 wj07 不存在，请联系管理员")

    role_val = _role_value(current_user.role)
    sender_name = current_user.display_name or current_user.username
    feedback_type_label = FEEDBACK_TYPE_MAP.get(payload.feedback_type, payload.feedback_type or "其他")

    title = f"用户反馈｜{feedback_type_label}"
    if payload.subject:
        title = f"{title}｜{payload.subject}"

    content = (
        f"提交人: {sender_name} ({current_user.username})\n"
        f"角色: {role_val}\n"
        f"页面: {payload.page_path or '-'}\n"
        f"类型: {feedback_type_label}\n\n"
        f"反馈内容:\n{payload.content}"
    )

    db.add(
        Notification(
            user_id=maintainer.id,
            type="user_feedback",
            title=title[:200],
            content=content,
            is_read=False,
            sender_id=current_user.id,
        )
    )
    db.commit()

    return {"message": "反馈已提交给维护人员 wj07"}


@router.get("")
async def list_feedback(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    is_read: Optional[bool] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取反馈列表（wj07/manager 可查看所有，普通用户仅查看自己提交的）"""
    query = db.query(Notification).filter(Notification.type == "user_feedback")

    if _is_feedback_manager(current_user):
        pass
    else:
        query = query.filter(Notification.sender_id == current_user.id)

    if is_read is not None:
        query = query.filter(Notification.is_read == is_read)

    query = query.order_by(desc(Notification.created_at))
    total = query.count()
    total_pages = (total + page_size - 1) // page_size if page_size else 0
    items = query.offset((page - 1) * page_size).limit(page_size).all()

    sender_ids = {n.sender_id for n in items if n.sender_id}
    sender_map = {}
    if sender_ids:
        users = db.query(User).filter(User.id.in_(sender_ids)).all()
        sender_map = {u.id: (u.display_name or u.username) for u in users}

    import re
    for n in items:
        if not n.sender_id and n.content:
            m = re.search(r'提交人:\s*\S+\s*\((\w+)\)', n.content)
            if m:
                fallback_user = db.query(User).filter(User.username == m.group(1)).first()
                if fallback_user:
                    n.sender_id = fallback_user.id
                    sender_map[fallback_user.id] = fallback_user.display_name or fallback_user.username
    db.flush()

    reply_parent_ids = {n.reply_to_id for n in items if n.reply_to_id}
    reply_counts = {}
    if reply_parent_ids:
        from sqlalchemy import func
        rows = (
            db.query(Notification.reply_to_id, func.count(Notification.id))
            .filter(
                Notification.type == "feedback_reply",
                Notification.reply_to_id.in_(reply_parent_ids),
            )
            .group_by(Notification.reply_to_id)
            .all()
        )
        reply_counts = {r[0]: r[1] for r in rows}

    all_ids = [n.id for n in items]
    all_reply_counts = {}
    if all_ids:
        from sqlalchemy import func
        rows2 = (
            db.query(Notification.reply_to_id, func.count(Notification.id))
            .filter(
                Notification.type == "feedback_reply",
                Notification.reply_to_id.in_(all_ids),
            )
            .group_by(Notification.reply_to_id)
            .all()
        )
        all_reply_counts = {r[0]: r[1] for r in rows2}

    return {
        "items": [
            {
                "id": n.id,
                "title": n.title,
                "content": n.content or "",
                "is_read": n.is_read,
                "sender_id": n.sender_id,
                "sender_name": sender_map.get(n.sender_id, "未知"),
                "reply_count": all_reply_counts.get(n.id, 0),
                "created_at": n.created_at.isoformat() if n.created_at else None,
            }
            for n in items
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
    }


@router.get("/{feedback_id}/replies")
async def get_feedback_replies(
    feedback_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取某条反馈的回复列表"""
    parent = db.query(Notification).filter(
        Notification.id == feedback_id,
        Notification.type == "user_feedback",
    ).first()
    if not parent:
        raise HTTPException(status_code=404, detail="反馈不存在")

    if not _is_feedback_manager(current_user) and parent.sender_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权查看")

    replies = (
        db.query(Notification)
        .filter(Notification.reply_to_id == feedback_id, Notification.type == "feedback_reply")
        .order_by(Notification.created_at)
        .all()
    )

    sender_ids = {r.sender_id for r in replies if r.sender_id}
    sender_ids.add(parent.sender_id) if parent.sender_id else None
    sender_map = {}
    if sender_ids:
        users = db.query(User).filter(User.id.in_(sender_ids)).all()
        sender_map = {u.id: (u.display_name or u.username) for u in users}

    return {
        "feedback": {
            "id": parent.id,
            "title": parent.title,
            "content": parent.content or "",
            "sender_id": parent.sender_id,
            "sender_name": sender_map.get(parent.sender_id, "未知"),
            "created_at": parent.created_at.isoformat() if parent.created_at else None,
        },
        "replies": [
            {
                "id": r.id,
                "content": r.content or "",
                "sender_id": r.sender_id,
                "sender_name": sender_map.get(r.sender_id, "未知"),
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in replies
        ],
    }


@router.patch("/{feedback_id}/mark-read")
async def mark_feedback_read(
    feedback_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """标记反馈为已处理（仅 wj07/manager）"""
    if not _is_feedback_manager(current_user):
        raise HTTPException(status_code=403, detail="无权操作")

    fb = db.query(Notification).filter(
        Notification.id == feedback_id,
        Notification.type == "user_feedback",
    ).first()
    if not fb:
        raise HTTPException(status_code=404, detail="反馈不存在")

    fb.is_read = True
    db.commit()
    return {"message": "已标记为已处理"}


@router.patch("/{feedback_id}/mark-unread")
async def mark_feedback_unread(
    feedback_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """标记反馈为待处理（仅 wj07/manager）"""
    if not _is_feedback_manager(current_user):
        raise HTTPException(status_code=403, detail="无权操作")

    fb = db.query(Notification).filter(
        Notification.id == feedback_id,
        Notification.type == "user_feedback",
    ).first()
    if not fb:
        raise HTTPException(status_code=404, detail="反馈不存在")

    fb.is_read = False
    db.commit()
    return {"message": "已标记为待处理"}


@router.post("/{feedback_id}/reply")
async def reply_feedback(
    feedback_id: int,
    payload: FeedbackReply,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """回复反馈（wj07/manager 回复提交人，提交人追加回复给 wj07）"""
    parent = db.query(Notification).filter(
        Notification.id == feedback_id,
        Notification.type == "user_feedback",
    ).first()
    if not parent:
        raise HTTPException(status_code=404, detail="反馈不存在")

    is_manager_reply = _is_feedback_manager(current_user)
    is_sender = parent.sender_id and parent.sender_id == current_user.id

    if not is_manager_reply and not is_sender:
        raise HTTPException(status_code=403, detail="无权回复")

    replier_name = current_user.display_name or current_user.username

    if is_manager_reply:
        recipient_id = parent.sender_id
        if not recipient_id:
            import re
            m = re.search(r'提交人:\s*\S+\s*\((\w+)\)', parent.content or '')
            if m:
                sender_user = db.query(User).filter(User.username == m.group(1)).first()
                if sender_user:
                    recipient_id = sender_user.id
                    parent.sender_id = sender_user.id
        if not recipient_id:
            raise HTTPException(status_code=400, detail="该反馈无提交人记录，无法回复")
    else:
        maintainer = db.query(User).filter(User.username == "wj07").first()
        if not maintainer:
            raise HTTPException(status_code=500, detail="维护人员 wj07 不存在")
        recipient_id = maintainer.id

    db.add(
        Notification(
            user_id=recipient_id,
            type="feedback_reply",
            title=f"反馈回复｜{parent.title[:80]}",
            content=f"回复人: {replier_name}\n\n{payload.content}",
            is_read=False,
            sender_id=current_user.id,
            reply_to_id=feedback_id,
        )
    )

    if not parent.is_read and is_manager_reply:
        parent.is_read = True

    db.commit()

    return {"message": "回复已发送"}
