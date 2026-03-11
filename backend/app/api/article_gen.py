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
from app.services.campaign_link_sync_service import CampaignLinkSyncService

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

    # --- 图片质量预检：下载图片头部验证实际尺寸，过滤低质量图 ---
    if unique_images:
        validated = await _validate_images_batch(unique_images, min_width=600, min_height=400)
        filtered_count = len(unique_images) - len(validated)
        if filtered_count > 0:
            logger.info("[Crawl] 图片质量预检: %d -> %d (过滤 %d 张低质量图)",
                        len(unique_images), len(validated), filtered_count)
        unique_images = validated
        seen = set(unique_images)

    # 网站图片不足时，用图片库补充
    crawled_count = len(unique_images)
    if crawled_count <= 2:
        brand = crawl_data.get("brand_name", "")
        queries = []
        if brand:
            queries.append(f"{brand} products official")
        if analysis and isinstance(analysis, dict):
            products = analysis.get("products") or analysis.get("main_products") or ""
            if products:
                prod_text = products if isinstance(products, str) else ", ".join(products[:3]) if isinstance(products, list) else str(products)
                queries.append(prod_text[:60])
            category = analysis.get("category", "")
            if category and category != "general":
                queries.append(f"{category} products lifestyle")
        if not brand:
            from urllib.parse import urlparse as _urlparse
            domain = _urlparse(data.url).hostname or ""
            domain_name = domain.replace("www.", "").split(".")[0]
            if domain_name and len(domain_name) > 2:
                queries.append(f"{domain_name} brand products")
        if not queries:
            queries.append("online shopping products lifestyle")

        for q in queries:
            if len(unique_images) >= 10:
                break
            try:
                extra = search_merchant_images(
                    q, count=12,
                    brand_name=brand,
                    category=analysis.get("category", "") if isinstance(analysis, dict) else ""
                )
                for img in extra:
                    if img not in seen:
                        seen.add(img)
                        unique_images.append(img)
                logger.info("[Crawl] 图片库搜索 '%s' 返回 %d 张", q, len(extra))
            except Exception as e:
                logger.warning("[Crawl] 图片库搜索失败 '%s': %s", q, e)

        logger.info("[Crawl] 网站 %d 张图 -> 补充后 %d 张", crawled_count, len(unique_images))

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


@router.post("/campaign-link/sync")
async def sync_campaign_links(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """手动触发当前用户的 Campaign Link 缓存同步（OPT-016，后台执行）"""
    import threading
    from app.database import SessionLocal

    user_id = current_user.id
    username = current_user.username

    def _bg_sync():
        bg_db = SessionLocal()
        try:
            svc = CampaignLinkSyncService(bg_db)
            cached = svc.sync_user(user_id)
            logger.info("[CampaignLinkSync] 用户 %s 后台同步完成: %d 条", username, cached)
        except Exception as e:
            logger.error("[CampaignLinkSync] 用户 %s 后台同步失败: %s", username, e)
        finally:
            bg_db.close()

    threading.Thread(target=_bg_sync, daemon=True).start()
    return {"success": True, "message": "同步已在后台启动，数据量较大请稍等几分钟"}


@router.post("/campaign-link/sync-all")
async def sync_all_campaign_links(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """手动触发所有用户的 Campaign Link 缓存全量同步（仅管理员，OPT-016，后台执行）"""
    if current_user.role not in ("manager", "admin"):
        raise HTTPException(status_code=403, detail="仅管理员可执行全量同步")

    import threading
    from app.database import SessionLocal

    def _bg_sync_all():
        bg_db = SessionLocal()
        try:
            svc = CampaignLinkSyncService(bg_db)
            result = svc.sync_all_users()
            logger.info("[CampaignLinkSync] 全量同步完成: %d 用户, %d 条缓存", result['total_users'], result['total_cached'])
        except Exception as e:
            logger.error("[CampaignLinkSync] 全量同步失败: %s", e)
        finally:
            bg_db.close()

    threading.Thread(target=_bg_sync_all, daemon=True).start()
    return {"success": True, "message": "全量同步已在后台启动，预计需要 10-30 分钟"}


# ==================== 图片质量预检工具 ====================

async def _validate_single_image(url: str, min_width: int, min_height: int) -> Optional[str]:
    """异步下载图片头部，验证实际分辨率。通过返回 url，不通过返回 None"""
    import httpx as _httpx
    import struct

    # URL 级别快速过滤
    url_lower = url.lower()
    skip_keywords = [
        "icon", "logo", "favicon", "sprite", "1x1", "pixel", "spacer",
        "blank", "avatar", "badge", "flag", "star", "rating", "social",
        "facebook", "twitter", "instagram", "linkedin", "youtube",
        "payment", "visa", "mastercard", "paypal", "amex",
        "svg+xml", ".svg", ".gif",
    ]
    if any(kw in url_lower for kw in skip_keywords):
        return None

    try:
        async with _httpx.AsyncClient(timeout=8, follow_redirects=True) as client:
            # 只下载前 32KB 足够读取图片头部尺寸信息
            resp = await client.get(url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Range": "bytes=0-32767",
                "Accept": "image/*,*/*;q=0.8",
            })
            if resp.status_code not in (200, 206):
                return None
            content_type = resp.headers.get("content-type", "")
            if "text/html" in content_type or "application/json" in content_type:
                return None
            data = resp.content
            if len(data) < 100:
                return None

            # 尝试用 PIL 读取尺寸（最可靠）
            try:
                from PIL import Image
                import io
                img = Image.open(io.BytesIO(data))
                w, h = img.size
                if w < min_width or h < min_height:
                    return None
                # 检查是否是纯色/渐变占位图（方差极低）
                if w <= 2000 and h <= 2000:
                    try:
                        import numpy as np
                        arr = np.array(img.convert('L'), dtype=np.float64)
                        if arr.std() < 10:  # 几乎纯色
                            return None
                    except ImportError:
                        pass
                return url
            except Exception:
                pass

            # PIL 失败时用文件头手动解析
            w, h = _parse_image_dimensions(data)
            if w and h and w >= min_width and h >= min_height:
                return url
            if w and h:
                return None  # 尺寸已知但太小

            # 无法判断尺寸时，用 content-length 估算
            cl = int(resp.headers.get("content-length", 0))
            if cl > 50000:  # > 50KB 大概率是有效图片
                return url
            return None
    except Exception:
        return None


def _parse_image_dimensions(data: bytes):
    """从图片文件头解析宽高"""
    import struct
    # JPEG
    if data[:2] == b'\xff\xd8':
        i = 2
        while i < len(data) - 9:
            if data[i] != 0xFF:
                break
            marker = data[i + 1]
            if marker in (0xC0, 0xC1, 0xC2):
                h = struct.unpack('>H', data[i+5:i+7])[0]
                w = struct.unpack('>H', data[i+7:i+9])[0]
                return w, h
            length = struct.unpack('>H', data[i+2:i+4])[0]
            i += 2 + length
    # PNG
    if data[:8] == b'\x89PNG\r\n\x1a\n' and len(data) >= 24:
        w = struct.unpack('>I', data[16:20])[0]
        h = struct.unpack('>I', data[20:24])[0]
        return w, h
    # WebP
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        if data[12:16] == b'VP8 ' and len(data) >= 30:
            w = struct.unpack('<H', data[26:28])[0] & 0x3FFF
            h = struct.unpack('<H', data[28:30])[0] & 0x3FFF
            return w, h
        if data[12:16] == b'VP8L' and len(data) >= 25:
            bits = struct.unpack('<I', data[21:25])[0]
            w = (bits & 0x3FFF) + 1
            h = ((bits >> 14) & 0x3FFF) + 1
            return w, h
    return None, None


async def _validate_images_batch(urls: list, min_width: int = 600,
                                  min_height: int = 400, max_concurrent: int = 8) -> list:
    """批量异步验证图片质量，返回通过的 URL 列表"""
    import asyncio
    semaphore = asyncio.Semaphore(max_concurrent)

    async def _check(url):
        async with semaphore:
            return await _validate_single_image(url, min_width, min_height)

    results = await asyncio.gather(*[_check(u) for u in urls])
    return [r for r in results if r is not None]
