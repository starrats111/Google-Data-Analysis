"""
公开文章 API（无需认证）
外部网站通过此 API 实时获取已发布的文章，解决 Cloudflare Pages 静态站无法读取服务器本地文件的问题。
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.models.article import PubArticle, PubCategory
from app.models.site import PubSite

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/public", tags=["公开接口"])


@router.get("/articles/{domain}")
async def get_site_articles(
    domain: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """
    根据域名获取该网站已发布的文章列表。
    无需认证，供外部网站 JS 调用。
    返回格式兼容 AuraBloom 等静态站的 posts 数组结构。
    """
    site = db.query(PubSite).filter(PubSite.domain == domain).first()
    if not site:
        return JSONResponse(
            content={"posts": [], "total": 0, "error": "site not found"},
            headers=_cors_headers(domain),
        )

    query = (
        db.query(PubArticle)
        .filter(
            PubArticle.site_id == site.id,
            PubArticle.published_to_site == True,
            PubArticle.status == "published",
            PubArticle.deleted_at.is_(None),
        )
        .options(joinedload(PubArticle.category))
        .order_by(PubArticle.created_at.desc())
    )

    total = query.count()
    articles = query.offset((page - 1) * page_size).limit(page_size).all()

    posts = []
    for a in articles:
        category_name = a.category.name if a.category else "General"
        posts.append({
            "id": a.id,
            "slug": a.slug,
            "title": a.title,
            "category": category_name,
            "dateISO": a.created_at.strftime("%Y-%m-%d") if a.created_at else "",
            "dateLabel": a.created_at.strftime("%b %-d, %Y") if a.created_at else "",
            "readTime": f"{max(3, len(a.content or '') // 1000)} min read",
            "excerpt": a.excerpt or "",
            "heroImage": a.featured_image or "",
            "content": a.content or "",
            "author": a.author or "",
            "tags": (a.meta_keywords or "").split(",") if a.meta_keywords else [],
            "detailUrl": f"article-{a.slug}.html",
        })

    return JSONResponse(
        content={"posts": posts, "total": total, "site_name": site.site_name},
        headers=_cors_headers(domain),
    )


@router.get("/article/{domain}/{slug}")
async def get_site_article_detail(
    domain: str,
    slug: str,
    db: Session = Depends(get_db),
):
    """获取单篇文章详情（含完整 HTML 内容）"""
    site = db.query(PubSite).filter(PubSite.domain == domain).first()
    if not site:
        return JSONResponse(
            content={"error": "site not found"},
            status_code=404,
            headers=_cors_headers(domain),
        )

    article = (
        db.query(PubArticle)
        .filter(
            PubArticle.site_id == site.id,
            PubArticle.slug == slug,
            PubArticle.published_to_site == True,
            PubArticle.deleted_at.is_(None),
        )
        .options(joinedload(PubArticle.category))
        .first()
    )
    if not article:
        return JSONResponse(
            content={"error": "article not found"},
            status_code=404,
            headers=_cors_headers(domain),
        )

    category_name = article.category.name if article.category else "General"
    return JSONResponse(
        content={
            "id": article.id,
            "slug": article.slug,
            "title": article.title,
            "category": category_name,
            "dateISO": article.created_at.strftime("%Y-%m-%d") if article.created_at else "",
            "content": article.content or "",
            "excerpt": article.excerpt or "",
            "heroImage": article.featured_image or "",
            "author": article.author or "",
            "tags": (article.meta_keywords or "").split(",") if article.meta_keywords else [],
        },
        headers=_cors_headers(domain),
    )


def _cors_headers(domain: str) -> dict:
    """CORS headers for cross-origin website access"""
    return {
        "Access-Control-Allow-Origin": f"https://{domain}",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Cache-Control": "public, max-age=60",
    }
