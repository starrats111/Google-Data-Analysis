"""
AI 生成 API（OPT-011/012/015）
"""
import json
import logging
import asyncio
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import desc

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.tracking_link import PubTrackingLink
from app.services.article_gen_service import ArticleGenService
from app.services.merchant_crawler import crawl as crawl_merchant, search_images as search_merchant_images
from app.services.campaign_link_service import CampaignLinkService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/article-gen", tags=["AI生成"])


class TitleGenRequest(BaseModel):
    prompt: str
    count: int = 10


class ArticleGenRequest(BaseModel):
    title: str
    keywords: Optional[List[str]] = None
    links: Optional[List[dict]] = None
    style: str = "informative"


class ImageGenRequest(BaseModel):
    title: str
    count: int = 5


class CrawlRequest(BaseModel):
    url: str
    language: str = "zh"


class MerchantArticleRequest(BaseModel):
    title: str
    merchant_info: dict
    tracking_link: str
    keywords: Optional[List[str]] = None
    language: str = "zh"


class CampaignLinkRequest(BaseModel):
    platform_code: str
    merchant_id: str


class ImageSearchRequest(BaseModel):
    query: str
    count: int = 12


@router.post("/titles")
async def generate_titles(
    data: TitleGenRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        service = ArticleGenService()
        titles = service.generate_titles(data.prompt, data.count)
        return {"titles": titles}
    except Exception as e:
        logger.error(f"标题生成失败: {e}")
        raise HTTPException(status_code=500, detail=f"标题生成失败: {str(e)}")


@router.post("/article")
async def generate_article(
    data: ArticleGenRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        service = ArticleGenService()
        result = service.generate_article(
            title=data.title,
            keywords=data.keywords,
            links=data.links,
            style=data.style,
        )
        return result
    except Exception as e:
        logger.error(f"文章生成失败: {e}")
        raise HTTPException(status_code=500, detail=f"文章生成失败: {str(e)}")


@router.post("/images")
async def generate_images(
    data: ImageGenRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        service = ArticleGenService()
        images = service.generate_images(data.title, data.count)
        return {"images": images}
    except Exception as e:
        logger.error(f"配图生成失败: {e}")
        raise HTTPException(status_code=500, detail=f"配图生成失败: {str(e)}")


@router.post("/crawl")
async def crawl_merchant_site(
    data: CrawlRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """爬取商家网站并 AI 分析（OPT-012）"""
    crawl_data = crawl_merchant(data.url)
    if crawl_data.get("crawl_failed"):
        raise HTTPException(status_code=400, detail=crawl_data.get("error", "爬取失败"))

    try:
        service = ArticleGenService()
        analysis = service.analyze_merchant(crawl_data, data.language)
    except Exception as e:
        logger.error(f"商家分析失败: {e}")
        raise HTTPException(status_code=500, detail=f"商家分析失败: {str(e)}")

    all_images = []
    for page in crawl_data.get("pages", []):
        all_images.extend(page.get("images", []))
    seen = set()
    unique_images = []
    for img in all_images:
        if img not in seen:
            seen.add(img)
            unique_images.append(img)

    # 只有网站本身图片极少（<= 2 张）时，才用图片库补充
    if len(unique_images) <= 2:
        brand = crawl_data.get("brand_name", "")
        if brand:
            search_query = f"{brand} products official"
            extra_images = search_merchant_images(search_query, count=12)
            for img in extra_images:
                if img not in seen:
                    seen.add(img)
                    unique_images.append(img)
            logger.info(f"[Crawl] 网站仅 {len(unique_images) - len(extra_images)} 张图，已从图片库补充")

    return {
        "brand_name": crawl_data.get("brand_name", ""),
        "url": data.url,
        "images": unique_images[:30],
        "analysis": analysis,
    }


@router.post("/search-images")
async def search_images_api(
    data: ImageSearchRequest,
    current_user: User = Depends(get_current_user),
):
    """搜索商家相关图片（补充爬取不足时使用）"""
    if not data.query.strip():
        raise HTTPException(status_code=400, detail="搜索关键词不能为空")
    images = search_merchant_images(data.query.strip(), count=data.count)
    return {"images": images, "query": data.query}


@router.post("/merchant-article")
async def generate_merchant_article(
    data: MerchantArticleRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """生成商家推广文章（OPT-012）— SSE 流式响应避免网关超时"""
    async def event_stream():
        loop = asyncio.get_event_loop()
        import concurrent.futures
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)

        future = loop.run_in_executor(executor, _generate_article_sync,
            data.title, data.merchant_info, data.tracking_link, data.keywords, data.language)

        while not future.done():
            yield f"data: {json.dumps({'status': 'generating', 'progress': 'AI 正在撰写文章...'})}\n\n"
            await asyncio.sleep(3)

        try:
            result = future.result()
            tracking = PubTrackingLink(
                user_id=current_user.id,
                merchant_url=data.merchant_info.get("url", ""),
                tracking_link=data.tracking_link,
                brand_name=data.merchant_info.get("brand_name", ""),
            )
            db.add(tracking)
            db.commit()
            yield f"data: {json.dumps({'status': 'done', 'result': result})}\n\n"
        except Exception as e:
            logger.error(f"商家文章生成失败: {e}")
            yield f"data: {json.dumps({'status': 'error', 'detail': str(e)})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


def _generate_article_sync(title, merchant_info, tracking_link, keywords, language):
    service = ArticleGenService()
    return service.generate_merchant_article(
        title=title,
        merchant_info=merchant_info,
        tracking_link=tracking_link,
        keywords=keywords,
        language=language,
    )


@router.get("/tracking-links")
async def get_tracking_links(
    limit: int = Query(50, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取当前用户的追踪链接历史（OPT-012，L-26 闭环）"""
    links = (
        db.query(PubTrackingLink)
        .filter(PubTrackingLink.user_id == current_user.id)
        .order_by(desc(PubTrackingLink.created_at))
        .limit(limit)
        .all()
    )
    return {
        "items": [
            {
                "id": lk.id,
                "merchant_url": lk.merchant_url,
                "tracking_link": lk.tracking_link,
                "brand_name": lk.brand_name,
                "created_at": lk.created_at.isoformat() if lk.created_at else None,
            }
            for lk in links
        ]
    }


@router.get("/image-proxy")
async def image_proxy(
    url: str = Query(..., description="要代理的图片 URL"),
):
    """图片代理：由服务器端请求图片，绕过商家网站防盗链（无需认证，img标签无法带token）"""
    import httpx as _httpx
    # 基本安全检查：只允许 http/https
    if not url.startswith(("http://", "https://")):
        return Response(content=b"", status_code=400)
    try:
        async with _httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
            resp = await client.get(url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                "Referer": url,
                "Accept": "image/*,*/*;q=0.8",
            })
            resp.raise_for_status()
            content_type = resp.headers.get("content-type", "image/jpeg")
            return Response(content=resp.content, media_type=content_type,
                            headers={"Cache-Control": "public, max-age=86400"})
    except Exception:
        # 返回 1x1 透明 PNG 作为 fallback
        import base64
        pixel = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAAA0lEQVQI12P4z8BQDwAEgAF/QualzQAAAABJRU5ErkJggg==")
        return Response(content=pixel, media_type="image/png")


@router.post("/campaign-link")
async def get_campaign_link(
    data: CampaignLinkRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取 Campaign Link（OPT-015）"""
    svc = CampaignLinkService(db)
    return svc.get_campaign_link(current_user.id, data.platform_code, data.merchant_id)


@router.get("/user-platforms")
async def get_user_platforms(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取当前用户有账号的平台列表（OPT-015）"""
    svc = CampaignLinkService(db)
    return {"platforms": svc.get_user_platforms(current_user.id)}
