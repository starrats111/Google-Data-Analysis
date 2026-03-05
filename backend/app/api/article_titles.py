"""
标题库 API（OPT-011）
"""
import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.article import PubArticleTitle

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/article-titles", tags=["标题库"])


class TitleItem(BaseModel):
    title: str
    title_en: str = ""
    score: float = 0
    prompt: str = ""


class TitleBatchCreate(BaseModel):
    titles: List[TitleItem]


@router.get("")
async def list_titles(
    used: str = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = db.query(PubArticleTitle).filter(
        PubArticleTitle.user_id == current_user.id,
    )
    if used == "true":
        query = query.filter(PubArticleTitle.used.is_(True))
    elif used == "false":
        query = query.filter(PubArticleTitle.used.is_(False))

    total = query.count()
    items = query.order_by(PubArticleTitle.created_at.desc()).offset(
        (page - 1) * page_size
    ).limit(page_size).all()

    return {
        "items": [
            {
                "id": t.id,
                "title": t.title,
                "title_en": t.title_en,
                "score": t.score,
                "prompt": t.prompt,
                "used": t.used,
                "created_at": t.created_at.isoformat() if t.created_at else None,
            }
            for t in items
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.post("/batch")
async def batch_create_titles(
    data: TitleBatchCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    created = []
    for item in data.titles:
        t = PubArticleTitle(
            title=item.title,
            title_en=item.title_en,
            score=item.score,
            prompt=item.prompt,
            used=False,
            user_id=current_user.id,
        )
        db.add(t)
        created.append(t)

    db.commit()
    return {"message": f"已保存 {len(created)} 个标题", "count": len(created)}


@router.delete("/{title_id}")
async def delete_title(
    title_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    title = db.query(PubArticleTitle).filter(
        PubArticleTitle.id == title_id,
        PubArticleTitle.user_id == current_user.id,
    ).first()
    if not title:
        raise HTTPException(status_code=404, detail="标题不存在")

    db.delete(title)
    db.commit()
    return {"message": "标题已删除"}
