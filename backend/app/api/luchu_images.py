"""
露出图片代理 API - 绕过商家网站防盗链 + 图片上传

安全改进:
- 公开接口添加速率限制（60次/分钟/IP）
- Referer 校验
"""
import httpx
import hashlib
import logging
import asyncio
import os
import uuid
import base64
from datetime import datetime
from typing import Optional, List
from urllib.parse import unquote

from fastapi import APIRouter, Depends, HTTPException, Query, BackgroundTasks, UploadFile, File, Request
from fastapi.responses import Response, FileResponse
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.models.user import User
from app.middleware.auth import get_current_user, get_luchu_authorized_user

# 速率限制器
limiter = Limiter(key_func=get_remote_address)

logger = logging.getLogger(__name__)

# 图片上传配置
UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "uploads", "images")
os.makedirs(UPLOAD_DIR, exist_ok=True)
MAX_FILE_SIZE = 5 * 1024 * 1024  # 5MB
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}

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


async def _fetch_image_with_playwright(url: str) -> Optional[tuple]:
    """
    使用 Playwright 获取图片（绕过严格防盗链）
    返回 (content, content_type) 或 None
    """
    try:
        from playwright.async_api import async_playwright
        
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            )
            page = await context.new_page()
            
            try:
                response = await page.request.get(url, timeout=10000)
                if response.ok:
                    content = await response.body()
                    if len(content) > 500:  # 有效图片应该大于 500 字节
                        content_type = response.headers.get('content-type', 'image/jpeg')
                        await browser.close()
                        return (content, content_type)
            except Exception as e:
                logger.warning(f"[Image Proxy] Playwright 获取失败: {e}")
            finally:
                await browser.close()
    except Exception as e:
        logger.warning(f"[Image Proxy] Playwright 不可用: {e}")
    
    return None


@router.get("/proxy-public")
@limiter.limit("60/minute")  # 每分钟最多 60 次请求
async def proxy_image_public(
    request: Request,  # 速率限制需要 Request 对象
    url: str = Query(..., description="要代理的图片URL"),
    force_playwright: bool = Query(False, description="强制使用 Playwright")
):
    """
    公开的图片代理接口（无需登录）
    用于前端直接在 img src 中使用
    
    安全措施:
    - 速率限制: 60次/分钟/IP
    - Referer 校验: 仅允许来自白名单域名的请求
    """
    if not url:
        raise HTTPException(status_code=400, detail="缺少图片URL参数")
    
    # Referer 校验 - 防止被外部网站滥用
    referer = request.headers.get("referer", "")
    if referer:
        # 检查 Referer 是否来自允许的域名
        allowed_referers = [
            "google-data-analysis.top",
            "google-data-analysis.pages.dev",
            "localhost",
            "127.0.0.1"
        ]
        is_allowed = any(domain in referer for domain in allowed_referers)
        if not is_allowed:
            logger.warning(f"[Image Proxy] 非法 Referer 被拒绝: {referer[:100]}")
            raise HTTPException(status_code=403, detail="非法请求来源")
    
    # URL 解码
    url = unquote(url)
    
    # 验证 URL 格式
    if not url.startswith(('http://', 'https://')):
        raise HTTPException(status_code=400, detail="无效的图片URL")
    
    # 生成缓存 key
    cache_key = hashlib.md5(url.encode()).hexdigest()
    
    # 检查缓存
    if cache_key in _image_cache and not force_playwright:
        cached = _image_cache[cache_key]
        return Response(
            content=cached['content'],
            media_type=cached['content_type'],
            headers={
                "Cache-Control": "public, max-age=86400",
                "X-Proxy-Cache": "HIT"
            }
        )
    
    content = None
    content_type = "image/jpeg"
    
    # 方法1: httpx 直接请求（快速）
    if not force_playwright:
        try:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
                response = await client.get(
                    url,
                    headers={
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                        "Accept-Language": "en-US,en;q=0.9",
                        "Referer": url.split('/')[0] + '//' + url.split('/')[2] + '/',
                    }
                )
                
                if response.status_code == 200:
                    ct = response.headers.get("content-type", "image/jpeg")
                    if ct.startswith("image/"):
                        img_content = response.content
                        # 验证图片有效性（至少 1KB）
                        if len(img_content) > 1000:
                            content = img_content
                            content_type = ct
                            logger.info(
                                "[Image Proxy] httpx 成功",
                                extra={
                                    "action": "proxy_image",
                                    "method": "httpx",
                                    "success": True,
                                    "url": url[:100],
                                    "size_bytes": len(content),
                                    "content_type": ct
                                }
                            )
        except Exception as e:
            logger.warning(
                "[Image Proxy] httpx 失败",
                extra={
                    "action": "proxy_image",
                    "method": "httpx",
                    "success": False,
                    "url": url[:100],
                    "error": str(e)
                }
            )
    
    # 方法2: 如果 httpx 失败，使用 Playwright（绕过更严格的防盗链）
    if content is None:
        logger.info("[Image Proxy] 尝试 Playwright", extra={"action": "proxy_image", "method": "playwright", "url": url[:100]})
        result = await _fetch_image_with_playwright(url)
        if result:
            content, content_type = result
            logger.info(
                "[Image Proxy] Playwright 成功",
                extra={
                    "action": "proxy_image",
                    "method": "playwright",
                    "success": True,
                    "url": url[:100],
                    "size_bytes": len(content)
                }
            )
    
    # 如果成功获取到图片
    if content and len(content) > 500:
        # 限制大小
        if len(content) > 10 * 1024 * 1024:
            return Response(
                content=_get_placeholder_image("图片过大"),
                media_type="image/svg+xml",
                headers={"Cache-Control": "no-store"}  # P2 修复：SVG 占位图不缓存
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
    
    # 所有方法都失败，返回占位图
    logger.warning(
        "[Image Proxy] 所有方法失败",
        extra={
            "action": "proxy_image",
            "success": False,
            "url": url[:100],
            "methods_tried": ["httpx", "playwright"]
        }
    )
    return Response(
        content=_get_placeholder_image("无法加载"),
        media_type="image/svg+xml",
        headers={"Cache-Control": "no-store"}  # P2 修复：SVG 占位图不缓存，方便重试
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


async def _fetch_and_cache_image(url: str) -> tuple:
    """
    获取并缓存单张图片
    返回 (是否成功, 错误信息)
    """
    if not url or not url.startswith(('http://', 'https://')):
        return False, "无效URL"
    
    cache_key = hashlib.md5(url.encode()).hexdigest()
    
    # 已缓存则跳过
    if cache_key in _image_cache:
        return True, "已缓存"
    
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True, verify=False) as client:
            response = await client.get(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Accept-Encoding": "gzip, deflate, br",
                    "Connection": "keep-alive",
                    "Referer": url.split('/')[0] + '//' + url.split('/')[2] + '/',
                }
            )
            
            if response.status_code != 200:
                return False, f"HTTP {response.status_code}"
            
            content_type = response.headers.get("content-type", "image/jpeg")
            if not content_type.startswith("image/"):
                return False, f"非图片类型: {content_type}"
            
            content = response.content
            if len(content) > 10 * 1024 * 1024:
                return False, "图片过大"
            
            if len(content) < 100:
                return False, f"内容过小: {len(content)} bytes"
            
            # 添加到缓存
            if len(_image_cache) >= _CACHE_MAX_SIZE:
                first_key = next(iter(_image_cache))
                del _image_cache[first_key]
            
            _image_cache[cache_key] = {
                'content': content,
                'content_type': content_type
            }
            
            logger.info(f"[Image Preload] ✓ 成功: {url[:60]}... ({len(content)} bytes)")
            return True, "成功"
            
    except httpx.TimeoutException:
        return False, "超时"
    except httpx.ConnectError as e:
        return False, f"连接失败: {str(e)[:50]}"
    except Exception as e:
        return False, f"错误: {str(e)[:50]}"


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
            return url, await _fetch_and_cache_image(url)
    
    results = await asyncio.gather(*[fetch_with_limit(url) for url in urls])
    
    # 统计并记录每个URL的结果
    cached_count = 0
    for url, (success, msg) in results:
        if success:
            cached_count += 1
        else:
            logger.warning(f"[Image Preload] ✗ 失败: {url[:60]}... - {msg}")
    
    logger.info(f"[Image Preload] 完成: {cached_count}/{len(urls)} 张图片已缓存")
    
    return {
        "success": True,
        "cached": cached_count,
        "total": len(urls)
    }


@router.post("/upload")
async def upload_image(
    file: UploadFile = File(...),
    current_user: User = Depends(get_luchu_authorized_user)
):
    """
    上传图片到服务器
    
    返回图片的 URL 和 Base64 数据
    用于手动上传替代 AI 无法提取的图片
    """
    # 验证文件类型
    if not file.filename:
        raise HTTPException(status_code=400, detail="文件名为空")
    
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400, 
            detail=f"不支持的文件类型: {ext}，仅支持 {', '.join(ALLOWED_EXTENSIONS)}"
        )
    
    # 读取文件内容
    content = await file.read()
    
    # 验证文件大小
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=400, 
            detail=f"文件太大: {len(content) / 1024 / 1024:.1f}MB，最大支持 5MB"
        )
    
    # 验证是否为有效图片
    content_type = file.content_type or "image/jpeg"
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="上传的文件不是有效图片")
    
    # 生成唯一文件名
    date_str = datetime.now().strftime("%Y%m%d")
    unique_id = uuid.uuid4().hex[:8]
    filename = f"{date_str}_{unique_id}{ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)
    
    # 保存文件
    try:
        with open(filepath, "wb") as f:
            f.write(content)
        logger.info(f"[Image Upload] 成功保存: {filename} ({len(content)} bytes)")
    except Exception as e:
        logger.error(f"[Image Upload] 保存失败: {e}")
        raise HTTPException(status_code=500, detail="保存图片失败")
    
    # 生成 Base64
    mime_type = content_type
    if ext == ".png":
        mime_type = "image/png"
    elif ext in [".jpg", ".jpeg"]:
        mime_type = "image/jpeg"
    elif ext == ".webp":
        mime_type = "image/webp"
    elif ext == ".gif":
        mime_type = "image/gif"
    
    base64_data = f"data:{mime_type};base64,{base64.b64encode(content).decode('utf-8')}"
    
    # 返回图片信息
    return {
        "success": True,
        "filename": filename,
        "url": f"/api/luchu/images/uploaded/{filename}",
        "base64": base64_data,
        "size": len(content),
        "content_type": mime_type
    }


@router.get("/uploaded/{filename}")
async def get_uploaded_image(filename: str):
    """
    获取已上传的图片
    """
    # 安全检查：防止路径遍历
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="无效的文件名")
    
    filepath = os.path.join(UPLOAD_DIR, filename)
    
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404, detail="图片不存在")
    
    # 确定 MIME 类型
    ext = os.path.splitext(filename)[1].lower()
    mime_types = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif"
    }
    media_type = mime_types.get(ext, "image/jpeg")
    
    return FileResponse(
        filepath,
        media_type=media_type,
        headers={
            "Cache-Control": "public, max-age=86400"
        }
    )

