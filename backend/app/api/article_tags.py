"""
标签管理 API（OPT-011）
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user, get_current_manager_or_leader
from app.models.user import User
from app.models.article import PubTag
from app.utils.slug import generate_slug

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/article-tags", tags=["标签管理"])


class TagCreate(BaseModel):
    name: str


@router.get("")
async def list_tags(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    items = db.query(PubTag).order_by(PubTag.name).all()
    return [
        {"id": t.id, "name": t.name, "slug": t.slug}
        for t in items
    ]


@router.post("")
async def create_tag(
    data: TagCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    slug = generate_slug(data.name)
    existing = db.query(PubTag).filter(PubTag.slug == slug).first()
    if existing:
        return {"id": existing.id, "name": existing.name, "slug": existing.slug}

    tag = PubTag(name=data.name, slug=slug)
    db.add(tag)
    db.commit()
    db.refresh(tag)
    return {"id": tag.id, "name": tag.name, "slug": tag.slug}


@router.delete("/{tag_id}")
async def delete_tag(
    tag_id: int,
    current_user: User = Depends(get_current_manager_or_leader),
    db: Session = Depends(get_db),
):
    tag = db.query(PubTag).filter(PubTag.id == tag_id).first()
    if not tag:
        raise HTTPException(status_code=404, detail="标签不存在")

    db.delete(tag)
    db.commit()
    return {"message": "标签已删除"}
