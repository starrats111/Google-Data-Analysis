"""
文章 CRUD API（OPT-011）
"""
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session, joinedload, selectinload

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.article import (
    PubArticle, PubCategory, PubTag, PubArticleTag,
    PubArticleLink, PubArticleImage, PubArticleVersion,
)
from app.models.site import PubSite
from app.services import site_publisher
from app.services.remote_publisher import remote_publisher
from app.utils.slug import generate_slug

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/articles", tags=["文章管理"])


class ArticleCreate(BaseModel):
    title: str
    content: Optional[str] = None
    excerpt: Optional[str] = None
    status: str = "draft"
    category_id: Optional[int] = None
    category_name: Optional[str] = None
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
    content_images: Optional[list] = Field(default_factory=list)


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

    items = (
        query.options(
            selectinload(PubArticle.tags).joinedload(PubArticleTag.tag),
            selectinload(PubArticle.links),
            selectinload(PubArticle.images),
            joinedload(PubArticle.category),
            joinedload(PubArticle.user),
            joinedload(PubArticle.site),
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

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
            date_str = data.publish_date.replace('Z', '+00:00')
            publish_dt = datetime.fromisoformat(date_str)
        except ValueError:
            raise HTTPException(status_code=400, detail="publish_date 格式无效")

    category_id = data.category_id
    if not category_id and data.category_name:
        cat = (
            db.query(PubCategory)
            .filter(PubCategory.name == data.category_name, PubCategory.deleted_at.is_(None))
            .first()
        )
        if not cat:
            cat = PubCategory(
                name=data.category_name,
                slug=generate_slug(data.category_name),
                auto_created=True,
            )
            db.add(cat)
            db.flush()
        category_id = cat.id

    article = PubArticle(
        title=data.title,
        slug=slug,
        content=data.content,
        excerpt=data.excerpt,
        status=data.status,
        category_id=category_id,
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

    if data.content_images:
        for idx, img_url in enumerate(data.content_images):
            if img_url:
                db.add(PubArticleImage(
                    article_id=article.id,
                    url=img_url,
                    alt_text=f"Content image {idx + 1}",
                    position=idx + 1,
                    source="crawl",
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
    article = (
        db.query(PubArticle)
        .options(
            selectinload(PubArticle.tags).joinedload(PubArticleTag.tag),
            selectinload(PubArticle.links),
            selectinload(PubArticle.images),
            joinedload(PubArticle.category),
            joinedload(PubArticle.user),
            joinedload(PubArticle.site),
        )
        .filter(
            PubArticle.id == article_id,
            PubArticle.deleted_at.is_(None),
        ).first()
    )
    if not article:
        raise HTTPException(status_code=404, detail="文章不存在")
    return _article_to_dict(article)


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


class PublishToSiteRequest(BaseModel):
    site_id: int


@router.post("/{article_id}/publish-to-site")
async def publish_to_site(
    article_id: int,
    data: PublishToSiteRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """将文章发布到指定网站（通过 SSH 推送到宝塔服务器）"""
    article = db.query(PubArticle).options(
        joinedload(PubArticle.category),
        selectinload(PubArticle.tags).joinedload(PubArticleTag.tag),
        selectinload(PubArticle.images),
    ).filter(
        PubArticle.id == article_id,
        PubArticle.deleted_at.is_(None),
    ).first()
    if not article:
        raise HTTPException(status_code=404, detail="文章不存在")
    _check_article_permission(article, current_user)

    if article.status != "published":
        raise HTTPException(status_code=400, detail="文章状态必须为 published 才能发布到网站，请先发布文章")

    if article.published_to_site:
        raise HTTPException(status_code=400, detail="文章已发布到网站，请先移除再重新发布")

    site = db.query(PubSite).filter(PubSite.id == data.site_id).first()
    if not site:
        raise HTTPException(status_code=404, detail="网站不存在")

    # 通过 SSH 远程推送到宝塔服务器
    try:
        result = remote_publisher.publish_article(site, article)
    except Exception as e:
        import traceback
        logger.error(f"远程发布失败: {e}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"远程发布失败: {str(e)}")

    article.site_id = site.id
    article.site_article_slug = result["site_article_slug"]
    article.published_to_site = True

    # 若首次发布时自动检测到了架构，将配置保存到 PubSite
    detected = result.get("detected_config")
    if detected and not site.site_type:
        site.site_type = detected.get("site_type") or site.site_type
        site.data_js_path = detected.get("data_js_path") or site.data_js_path
        site.article_var_name = detected.get("article_var_name") or site.article_var_name
        site.article_html_pattern = detected.get("article_html_pattern") or site.article_html_pattern

    db.commit()

    logger.info(f"文章已发布到网站: slug={article.slug}, site={site.site_name}, domain={site.domain}")

    # 根据站点的 article_html_pattern 构造正确的文章 URL
    article_url = ""
    if site.domain:
        pattern = result.get("article_html_pattern") or site.article_html_pattern
        if pattern and "{slug}" in pattern:
            url_path = pattern.replace("{slug}", article.slug)
            article_url = f"https://{site.domain}/{url_path}"
        else:
            article_url = f"https://{site.domain}/post-{article.slug}.html"

    return {
        "message": "文章已发布到网站",
        "site_name": site.site_name,
        "site_domain": site.domain,
        "site_article_slug": article.slug,
        "article_url": article_url,
    }


@router.delete("/{article_id}/unpublish-from-site")
async def unpublish_from_site(
    article_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """从网站移除文章（通过 SSH 从宝塔服务器删除）"""
    article = db.query(PubArticle).filter(
        PubArticle.id == article_id,
        PubArticle.deleted_at.is_(None),
    ).first()
    if not article:
        raise HTTPException(status_code=404, detail="文章不存在")
    _check_article_permission(article, current_user)

    if not article.published_to_site or not article.site_id:
        raise HTTPException(status_code=400, detail="文章未发布到任何网站")

    site = db.query(PubSite).filter(PubSite.id == article.site_id).first()
    slug = article.site_article_slug or article.slug

    # 通过 SSH 远程删除
    if site:
        try:
            remote_publisher.unpublish_article(site, slug)
        except Exception as e:
            logger.error(f"远程移除失败: {e}")
            # 即使远程失败也清除本地标记
            pass

    article.site_id = None
    article.site_article_slug = None
    article.published_to_site = False
    db.commit()

    return {"message": "文章已从网站移除"}


def _article_to_dict(article: PubArticle, db: Session = None) -> dict:
    # 优先使用已加载的 relationship，避免 N+1 查询
    tag_list = []
    for at in (article.tags or []):
        tag = at.tag
        if tag:
            tag_list.append({"id": tag.id, "name": tag.name, "slug": tag.slug})

    category_name = article.category.name if article.category else None
    username = article.user.username if article.user else None

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
        "username": username,
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
        "links": [{"id": l.id, "keyword": l.keyword, "url": l.url} for l in (article.links or [])],
        "images": [{"id": i.id, "url": i.url, "alt_text": i.alt_text, "position": i.position} for i in (article.images or [])],
        "site_id": article.site_id,
        "site_article_slug": article.site_article_slug,
        "published_to_site": article.published_to_site or False,
        "site_name": (article.site.site_name if article.site else None),
        "site_domain": (article.site.domain if article.site else None),
        "article_url": _build_article_url(article),
        "created_at": article.created_at.isoformat() if article.created_at else None,
        "updated_at": article.updated_at.isoformat() if article.updated_at else None,
    }


def _build_article_url(article) -> str:
    """根据站点配置构造正确的文章外链"""
    site = article.site
    if not site or not site.domain or not article.site_article_slug:
        return ""
    slug = article.site_article_slug
    pattern = site.article_html_pattern
    if pattern and "{slug}" in pattern:
        url_path = pattern.replace("{slug}", slug)
        return f"https://{site.domain}/{url_path}"
    return f"https://{site.domain}/post-{slug}.html"
