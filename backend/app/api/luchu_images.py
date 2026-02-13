"""
露出图片代理 API - 绕过商家网站防盗链
"""
import httpx
import hashlib
import logging
import asyncio
from typing import Optional, List
from urllib.parse import unquote

from fastapi import APIRouter, Depends, HTTPException, Query, BackgroundTasks
from fastapi.responses import Response
from pydantic import BaseModel

from app.models.user import User
from app.middleware.auth import get_current_user, get_luchu_authorized_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/luchu/images", tags=["luchu-images"])

# 图片缓存（简单内存缓存，生产环境可用 Redis）
_image_cache = {}
_CACHE_MAX_SIZE = 200  # 最多缓存200张图片


class PreloadRequest(BaseModel):
    urls: List[str]


@router.get("/proxy")
async def proxy_image(
    url: str = Query(..., description="要代理的图片URL"),
    current_user: User = Depends(get_luchu_authorized_user)
):
    """
    代理获取外部图片，绕过防盗链限制
    
    使用方式：/api/luchu/images/proxy?url=https://example.com/image.jpg
    """
    if not url:
        raise HTTPException(status_code=400, detail="缺少图片URL参数")
    
    # URL 解码
    url = unquote(url)
    
    # 验证 URL 格式
    if not url.startswith(('http://', 'https://')):
        raise HTTPException(status_code=400, detail="无效的图片URL")
    
    # 生成缓存 key
    cache_key = hashlib.md5(url.encode()).hexdigest()
    
    # 检查缓存
    if cache_key in _image_cache:
        logger.debug(f"[Image Proxy] 缓存命中: {url[:50]}...")
        cached = _image_cache[cache_key]
        return Response(
            content=cached['content'],
            media_type=cached['content_type'],
            headers={
                "Cache-Control": "public, max-age=86400",  # 缓存24小时
                "X-Proxy-Cache": "HIT"
            }
        )
    
    try:
        logger.info(f"[Image Proxy] 获取图片: {url[:80]}...")
        
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            response = await client.get(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Referer": url.split('/')[0] + '//' + url.split('/')[2] + '/',  # 使用原网站作为 Referer
                }
            )
            
            if response.status_code != 200:
                logger.warning(f"[Image Proxy] 获取失败: HTTP {response.status_code}")
                raise HTTPException(
                    status_code=response.status_code, 
                    detail=f"获取图片失败: HTTP {response.status_code}"
                )
            
            content_type = response.headers.get("content-type", "image/jpeg")
            
            # 验证是否为图片
            if not content_type.startswith("image/"):
                logger.warning(f"[Image Proxy] 非图片类型: {content_type}")
                raise HTTPException(status_code=400, detail="URL不是有效的图片")
            
            content = response.content
            
            # 限制图片大小（最大 10MB）
            if len(content) > 10 * 1024 * 1024:
                raise HTTPException(status_code=400, detail="图片太大（超过10MB）")
            
            # 添加到缓存
            if len(_image_cache) >= _CACHE_MAX_SIZE:
                # 简单的 LRU：删除第一个
                first_key = next(iter(_image_cache))
                del _image_cache[first_key]
            
            _image_cache[cache_key] = {
                'content': content,
                'content_type': content_type
            }
            
            logger.info(f"[Image Proxy] 成功获取: {len(content)} bytes, {content_type}")
            
            return Response(
                content=content,
                media_type=content_type,
                headers={
                    "Cache-Control": "public, max-age=86400",
                    "X-Proxy-Cache": "MISS"
                }
            )
            
    except httpx.TimeoutException:
        logger.error(f"[Image Proxy] 超时: {url[:50]}...")
        raise HTTPException(status_code=504, detail="获取图片超时")
    except httpx.RequestError as e:
        logger.error(f"[Image Proxy] 请求错误: {e}")
        raise HTTPException(status_code=502, detail=f"获取图片失败: {str(e)}")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Image Proxy] 未知错误: {e}")
        raise HTTPException(status_code=500, detail=f"代理图片失败: {str(e)}")


@router.get("/proxy-public")
async def proxy_image_public(
    url: str = Query(..., description="要代理的图片URL")
):
    """
    公开的图片代理接口（无需登录）
    用于前端直接在 img src 中使用
    
    注意：此接口不需要认证，但有速率限制
    """
    if not url:
        raise HTTPException(status_code=400, detail="缺少图片URL参数")
    
    # URL 解码
    url = unquote(url)
    
    # 验证 URL 格式
    if not url.startswith(('http://', 'https://')):
        raise HTTPException(status_code=400, detail="无效的图片URL")
    
    # 生成缓存 key
    cache_key = hashlib.md5(url.encode()).hexdigest()
    
    # 检查缓存
    if cache_key in _image_cache:
        cached = _image_cache[cache_key]
        return Response(
            content=cached['content'],
            media_type=cached['content_type'],
            headers={
                "Cache-Control": "public, max-age=86400",
                "X-Proxy-Cache": "HIT"
            }
        )
    
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            response = await client.get(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Referer": url.split('/')[0] + '//' + url.split('/')[2] + '/',
                }
            )
            
            if response.status_code != 200:
                # 返回一个占位图
                return Response(
                    content=_get_placeholder_image(),
                    media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=300"}
                )
            
            content_type = response.headers.get("content-type", "image/jpeg")
            
            if not content_type.startswith("image/"):
                return Response(
                    content=_get_placeholder_image(),
                    media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=300"}
                )
            
            content = response.content
            
            if len(content) > 10 * 1024 * 1024:
                return Response(
                    content=_get_placeholder_image(),
                    media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=300"}
                )
            
            # 添加到缓存
            if len(_image_cache) >= _CACHE_MAX_SIZE:
                first_key = next(iter(_image_cache))
                del _image_cache[first_key]
            
            _image_cache[cache_key] = {
                'content': content,
                'content_type': content_type
            }
            
            return Response(
                content=content,
                media_type=content_type,
                headers={
                    "Cache-Control": "public, max-age=86400",
                    "X-Proxy-Cache": "MISS"
                }
            )
            
    except Exception:
        # 任何错误都返回占位图
        return Response(
            content=_get_placeholder_image(),
            media_type="image/svg+xml",
            headers={"Cache-Control": "public, max-age=300"}
        )


def _get_placeholder_image(text: str = "暂无图片") -> bytes:
    """生成占位图 SVG"""
    svg = f'''<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#f5f5f5"/>
        <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" 
              font-family="Arial, sans-serif" font-size="14" fill="#bbb">
            {text}
        </text>
    </svg>'''
    return svg.encode('utf-8')


async def _fetch_and_cache_image(url: str) -> bool:
    """
    获取并缓存单张图片
    返回是否成功
    """
    if not url or not url.startswith(('http://', 'https://')):
        return False
    
    cache_key = hashlib.md5(url.encode()).hexdigest()
    
    # 已缓存则跳过
    if cache_key in _image_cache:
        return True
    
    try:
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
            response = await client.get(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Referer": url.split('/')[0] + '//' + url.split('/')[2] + '/',
                }
            )
            
            if response.status_code != 200:
                return False
            
            content_type = response.headers.get("content-type", "image/jpeg")
            if not content_type.startswith("image/"):
                return False
            
            content = response.content
            if len(content) > 10 * 1024 * 1024:
                return False
            
            # 添加到缓存
            if len(_image_cache) >= _CACHE_MAX_SIZE:
                first_key = next(iter(_image_cache))
                del _image_cache[first_key]
            
            _image_cache[cache_key] = {
                'content': content,
                'content_type': content_type
            }
            
            logger.debug(f"[Image Preload] 缓存成功: {url[:50]}... ({len(content)} bytes)")
            return True
            
    except Exception as e:
        logger.debug(f"[Image Preload] 缓存失败: {url[:50]}... - {e}")
        return False


@router.post("/preload")
async def preload_images(
    request: PreloadRequest,
    current_user: User = Depends(get_luchu_authorized_user)
):
    """
    批量预加载图片到缓存
    在分析商家URL后调用，提前缓存所有图片
    """
    if not request.urls:
        return {"success": True, "cached": 0, "total": 0}
    
    urls = [unquote(url) for url in request.urls if url]
    
    logger.info(f"[Image Preload] 开始预加载 {len(urls)} 张图片")
    
    # 并发获取所有图片（最多同时5个）
    semaphore = asyncio.Semaphore(5)
    
    async def fetch_with_limit(url):
        async with semaphore:
            return await _fetch_and_cache_image(url)
    
    results = await asyncio.gather(*[fetch_with_limit(url) for url in urls])
    
    cached_count = sum(1 for r in results if r)
    
    logger.info(f"[Image Preload] 完成: {cached_count}/{len(urls)} 张图片已缓存")
    
    return {
        "success": True,
        "cached": cached_count,
        "total": len(urls)
    }

