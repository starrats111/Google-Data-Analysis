"""
分类管理 API（OPT-011）
"""
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user, get_current_manager_or_leader
from app.models.user import User
from app.models.article import PubCategory
from app.utils.slug import generate_slug

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/article-categories", tags=["分类管理"])


class CategoryCreate(BaseModel):
    name: str
    description: Optional[str] = None


class CategoryUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


@router.get("")
async def list_categories(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    items = db.query(PubCategory).filter(
        PubCategory.deleted_at.is_(None),
    ).order_by(PubCategory.name).all()

    return [
        {
            "id": c.id,
            "name": c.name,
            "slug": c.slug,
            "description": c.description,
            "created_at": c.created_at.isoformat() if c.created_at else None,
        }
        for c in items
    ]


@router.post("")
async def create_category(
    data: CategoryCreate,
    current_user: User = Depends(get_current_manager_or_leader),
    db: Session = Depends(get_db),
):
    slug = generate_slug(data.name)
    existing = db.query(PubCategory).filter(
        PubCategory.slug == slug,
        PubCategory.deleted_at.is_(None),
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="分类名称已存在")

    category = PubCategory(
        name=data.name,
        slug=slug,
        description=data.description,
    )
    db.add(category)
    db.commit()
    db.refresh(category)
    return {
        "id": category.id,
        "name": category.name,
        "slug": category.slug,
        "description": category.description,
    }


@router.put("/{category_id}")
async def update_category(
    category_id: int,
    data: CategoryUpdate,
    current_user: User = Depends(get_current_manager_or_leader),
    db: Session = Depends(get_db),
):
    cat = db.query(PubCategory).filter(
        PubCategory.id == category_id,
        PubCategory.deleted_at.is_(None),
    ).first()
    if not cat:
        raise HTTPException(status_code=404, detail="分类不存在")

    if data.name is not None:
        cat.name = data.name
        cat.slug = generate_slug(data.name)
    if data.description is not None:
        cat.description = data.description

    db.commit()
    db.refresh(cat)
    return {"id": cat.id, "name": cat.name, "slug": cat.slug, "description": cat.description}


@router.delete("/{category_id}")
async def delete_category(
    category_id: int,
    current_user: User = Depends(get_current_manager_or_leader),
    db: Session = Depends(get_db),
):
    cat = db.query(PubCategory).filter(
        PubCategory.id == category_id,
        PubCategory.deleted_at.is_(None),
    ).first()
    if not cat:
        raise HTTPException(status_code=404, detail="分类不存在")

    cat.deleted_at = datetime.now()
    db.commit()
    return {"message": "分类已删除"}
