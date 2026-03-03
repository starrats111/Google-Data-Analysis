"""
用户反馈 API
所有用户可提交反馈，统一投递给维护人员 wj07
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.notification import Notification

router = APIRouter(prefix="/api/feedback", tags=["feedback"])


class FeedbackCreate(BaseModel):
    feedback_type: str = Field(default="other", max_length=50)
    subject: Optional[str] = Field(default=None, max_length=120)
    content: str = Field(min_length=5, max_length=3000)
    page_path: Optional[str] = Field(default=None, max_length=300)


@router.post("")
async def submit_feedback(
    payload: FeedbackCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    maintainer = db.query(User).filter(User.username == "wj07").first()
    if not maintainer:
        raise HTTPException(status_code=500, detail="维护人员账号 wj07 不存在，请联系管理员")

    role_val = current_user.role.value if hasattr(current_user.role, "value") else str(current_user.role)
    sender_name = current_user.display_name or current_user.username

    feedback_type_map = {
        "data_issue": "数据误差",
        "feature_experience": "功能体验",
        "bug_report": "功能异常",
        "feature_request": "功能建议",
        "other": "其他",
    }
    feedback_type_label = feedback_type_map.get(payload.feedback_type, payload.feedback_type or "其他")

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
        )
    )
    db.commit()

    return {"message": "反馈已提交给维护人员 wj07"}
