"""
文章 CRUD API（OPT-011）
"""
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.article import (
    PubArticle, PubCategory, PubTag, PubArticleTag,
    PubArticleLink, PubArticleImage, PubArticleVersion,
)
from app.utils.slug import generate_slug

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/articles", tags=["文章管理"])


class ArticleCreate(BaseModel):
    title: str
    content: Optional[str] = None
    excerpt: Optional[str] = None
    status: str = "draft"
    category_id: Optional[int] = None
    author: Optional[str] = None
    featured_image: Optional[str] = None
    publish_date: Optional[str] = None
    enable_keyword_links: bool = False
    meta_title: Optional[str] = None
    meta_description: Optional[str] = None
    meta_keywords: Optional[str] = None
    ai_model_used: Optional[str] = None
    merchant_url: Optional[str] = None
    tracking_link: Optional[str] = None
    language: Optional[str] = None
    tag_ids: Optional[list] = Field(default_factory=list)
    links: Optional[list] = Field(default_factory=list)


class ArticleUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    excerpt: Optional[str] = None
    status: Optional[str] = None
    category_id: Optional[int] = None
    author: Optional[str] = None
    featured_image: Optional[str] = None
    publish_date: Optional[str] = None
    enable_keyword_links: Optional[bool] = None
    meta_title: Optional[str] = None
    meta_description: Optional[str] = None
    meta_keywords: Optional[str] = None
    tag_ids: Optional[list] = None
    links: Optional[list] = None


def _check_article_permission(article: PubArticle, user: User):
    """权限校验：作者本人或 manager/leader"""
    if user.role in ("manager", "leader"):
        return
    if article.user_id != user.id:
        raise HTTPException(status_code=403, detail="无权操作此文章")


@router.get("")
async def list_articles(
    status: Optional[str] = None,
    category_id: Optional[int] = None,
    search: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    sort_by: str = "created_at",
    sort_order: str = "desc",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = db.query(PubArticle).filter(PubArticle.deleted_at.is_(None))

    if status:
        query = query.filter(PubArticle.status == status)
    if category_id:
        query = query.filter(PubArticle.category_id == category_id)
    if search:
        query = query.filter(PubArticle.title.ilike(f"%{search}%"))

    if current_user.role not in ("manager", "leader"):
        query = query.filter(PubArticle.user_id == current_user.id)

    total = query.count()

    sort_col = getattr(PubArticle, sort_by, PubArticle.created_at)
    if sort_order == "asc":
        query = query.order_by(sort_col.asc())
    else:
        query = query.order_by(sort_col.desc())

    items = query.offset((page - 1) * page_size).limit(page_size).all()

    return {
        "items": [_article_to_dict(a, db) for a in items],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.post("")
async def create_article(
    data: ArticleCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    slug = generate_slug(data.title)
    existing = db.query(PubArticle).filter(PubArticle.slug == slug).first()
    if existing:
        slug = f"{slug}-{int(datetime.now().timestamp())}"

    publish_dt = None
    if data.publish_date:
        try:
            publish_dt = datetime.fromisoformat(data.publish_date)
        except ValueError:
            raise HTTPException(status_code=400, detail="publish_date 格式无效")

    article = PubArticle(
        title=data.title,
        slug=slug,
        content=data.content,
        excerpt=data.excerpt,
        status=data.status,
        category_id=data.category_id,
        user_id=current_user.id,
        author=data.author or current_user.display_name or current_user.username,
        featured_image=data.featured_image,
        publish_date=publish_dt,
        enable_keyword_links=data.enable_keyword_links,
        meta_title=data.meta_title,
        meta_description=data.meta_description,
        meta_keywords=data.meta_keywords,
        ai_model_used=data.ai_model_used,
        merchant_url=data.merchant_url,
        tracking_link=data.tracking_link,
        language=data.language or "zh",
    )
    db.add(article)
    db.flush()

    if data.tag_ids:
        for tid in data.tag_ids:
            db.add(PubArticleTag(article_id=article.id, tag_id=tid))

    if data.links:
        for lnk in data.links:
            db.add(PubArticleLink(
                article_id=article.id,
                keyword=lnk.get("keyword", ""),
                url=lnk.get("url", ""),
            ))

    version = PubArticleVersion(
        article_id=article.id,
        version=1,
        title=data.title,
        content=data.content,
        changed_by=current_user.username,
    )
    db.add(version)
    db.commit()
    db.refresh(article)

    return _article_to_dict(article, db)


@router.get("/{article_id}")
async def get_article(
    article_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    article = db.query(PubArticle).filter(
        PubArticle.id == article_id,
        PubArticle.deleted_at.is_(None),
    ).first()
    if not article:
        raise HTTPException(status_code=404, detail="文章不存在")
    return _article_to_dict(article, db)


@router.put("/{article_id}")
async def update_article(
    article_id: int,
    data: ArticleUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    article = db.query(PubArticle).filter(
        PubArticle.id == article_id,
        PubArticle.deleted_at.is_(None),
    ).first()
    if not article:
        raise HTTPException(status_code=404, detail="文章不存在")
    _check_article_permission(article, current_user)

    content_changed = False
    update_data = data.dict(exclude_unset=True)

    if "publish_date" in update_data and update_data["publish_date"]:
        try:
            update_data["publish_date"] = datetime.fromisoformat(update_data["publish_date"])
        except ValueError:
            raise HTTPException(status_code=400, detail="publish_date 格式无效")

    tag_ids = update_data.pop("tag_ids", None)
    links = update_data.pop("links", None)

    for key, value in update_data.items():
        if key in ("title", "content"):
            if getattr(article, key) != value:
                content_changed = True
        setattr(article, key, value)

    if tag_ids is not None:
        db.query(PubArticleTag).filter(PubArticleTag.article_id == article.id).delete()
        for tid in tag_ids:
            db.add(PubArticleTag(article_id=article.id, tag_id=tid))

    if links is not None:
        db.query(PubArticleLink).filter(PubArticleLink.article_id == article.id).delete()
        for lnk in links:
            db.add(PubArticleLink(
                article_id=article.id,
                keyword=lnk.get("keyword", ""),
                url=lnk.get("url", ""),
            ))

    if content_changed:
        max_ver = db.query(PubArticleVersion).filter(
            PubArticleVersion.article_id == article.id,
        ).count()
        db.add(PubArticleVersion(
            article_id=article.id,
            version=max_ver + 1,
            title=article.title,
            content=article.content,
            changed_by=current_user.username,
        ))

    db.commit()
    db.refresh(article)
    return _article_to_dict(article, db)


@router.delete("/{article_id}")
async def delete_article(
    article_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    article = db.query(PubArticle).filter(
        PubArticle.id == article_id,
        PubArticle.deleted_at.is_(None),
    ).first()
    if not article:
        raise HTTPException(status_code=404, detail="文章不存在")
    _check_article_permission(article, current_user)

    article.deleted_at = datetime.now()
    db.commit()
    return {"message": "文章已删除"}


@router.get("/{article_id}/versions")
async def get_article_versions(
    article_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    article = db.query(PubArticle).filter(PubArticle.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="文章不存在")

    versions = db.query(PubArticleVersion).filter(
        PubArticleVersion.article_id == article_id,
    ).order_by(PubArticleVersion.version.desc()).all()

    return [
        {
            "id": v.id,
            "version": v.version,
            "title": v.title,
            "content": v.content,
            "changed_by": v.changed_by,
            "created_at": v.created_at.isoformat() if v.created_at else None,
        }
        for v in versions
    ]


def _article_to_dict(article: PubArticle, db: Session) -> dict:
    tags = db.query(PubArticleTag).filter(PubArticleTag.article_id == article.id).all()
    tag_list = []
    for at in tags:
        tag = db.query(PubTag).filter(PubTag.id == at.tag_id).first()
        if tag:
            tag_list.append({"id": tag.id, "name": tag.name, "slug": tag.slug})

    links = db.query(PubArticleLink).filter(PubArticleLink.article_id == article.id).all()
    images = db.query(PubArticleImage).filter(PubArticleImage.article_id == article.id).all()

    category_name = None
    if article.category_id:
        cat = db.query(PubCategory).filter(PubCategory.id == article.category_id).first()
        category_name = cat.name if cat else None

    user = db.query(User).filter(User.id == article.user_id).first()

    return {
        "id": article.id,
        "title": article.title,
        "slug": article.slug,
        "content": article.content,
        "excerpt": article.excerpt,
        "status": article.status,
        "category_id": article.category_id,
        "category_name": category_name,
        "user_id": article.user_id,
        "username": user.username if user else None,
        "author": article.author,
        "featured_image": article.featured_image,
        "publish_date": article.publish_date.isoformat() if article.publish_date else None,
        "enable_keyword_links": article.enable_keyword_links,
        "meta_title": article.meta_title,
        "meta_description": article.meta_description,
        "meta_keywords": article.meta_keywords,
        "views": article.views,
        "ai_model_used": article.ai_model_used,
        "tags": tag_list,
        "links": [{"id": l.id, "keyword": l.keyword, "url": l.url} for l in links],
        "images": [{"id": i.id, "url": i.url, "alt_text": i.alt_text, "position": i.position} for i in images],
        "created_at": article.created_at.isoformat() if article.created_at else None,
        "updated_at": article.updated_at.isoformat() if article.updated_at else None,
    }
