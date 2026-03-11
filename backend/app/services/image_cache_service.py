"""
图片缓存服务（CR-040）
爬虫阶段下载图片到本地缓存，前端展示缓存图，发布时从缓存上传到宝塔，发布后清理。
"""
import hashlib
import json
import logging
import os
import shutil
import uuid
from datetime import datetime, timedelta
from typing import Optional, List, Dict

import requests

from app.config import settings

logger = logging.getLogger(__name__)

# 缓存根目录
CACHE_ROOT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "uploads", "image_cache"
)


class ImageCacheService:
    """图片缓存管理"""

    def __init__(self):
        os.makedirs(CACHE_ROOT, exist_ok=True)

    # ─── 创建会话 ───

    def create_session(self) -> str:
        """创建新的缓存会话，返回 session_id"""
        session_id = uuid.uuid4().hex[:16]
        session_dir = os.path.join(CACHE_ROOT, session_id)
        os.makedirs(session_dir, exist_ok=True)
        manifest = {
            "session_id": session_id,
            "created_at": datetime.utcnow().isoformat(),
            "images": [],
        }
        self._write_manifest(session_id, manifest)
        logger.info("[ImageCache] 创建会话: %s", session_id)
        return session_id

    # ─── 下载图片到缓存 ───

    def download_to_cache(self, session_id: str, url: str, source: str = "crawl",
                          index: int = 0, min_width: int = 300, min_height: int = 200) -> Optional[Dict]:
        """
        下载单张图片到缓存目录。
        返回图片信息 dict，下载失败返回 None。
        """
        session_dir = os.path.join(CACHE_ROOT, session_id)
        if not os.path.isdir(session_dir):
            return None

        data = self._download_image(url)
        if not data:
            return None

        # 验证尺寸
        w, h = self._get_image_size(data)
        if w and h and (w < min_width or h < min_height):
            logger.debug("[ImageCache] 图片尺寸过小 %dx%d，跳过: %s", w, h, url[:80])
            return None

        ext = self._get_ext(url, data)
        filename = f"{source}_{index:03d}{ext}"
        filepath = os.path.join(session_dir, filename)
        with open(filepath, "wb") as f:
            f.write(data)

        md5 = hashlib.md5(data).hexdigest()
        info = {
            "cache_file": filename,
            "original_url": url,
            "source": source,
            "width": w or 0,
            "height": h or 0,
            "size_bytes": len(data),
            "md5": md5,
        }

        # 更新 manifest
        manifest = self._read_manifest(session_id)
        if manifest:
            # 去重：同 md5 不重复存
            existing_md5s = {img["md5"] for img in manifest["images"]}
            if md5 in existing_md5s:
                os.remove(filepath)
                logger.debug("[ImageCache] 重复图片跳过 (md5=%s): %s", md5[:8], url[:60])
                return None
            manifest["images"].append(info)
            self._write_manifest(session_id, manifest)

        return info

    def batch_download(self, session_id: str, urls: List[str], source: str = "crawl",
                       min_width: int = 300, min_height: int = 200, max_count: int = 30) -> List[Dict]:
        """批量下载图片到缓存，返回成功的图片信息列表"""
        results = []
        for i, url in enumerate(urls):
            if len(results) >= max_count:
                break
            info = self.download_to_cache(session_id, url, source, i, min_width, min_height)
            if info:
                results.append(info)
        logger.info("[ImageCache] 批量下载完成: %d/%d 成功 (session=%s, source=%s)",
                    len(results), len(urls), session_id, source)
        return results

    # ─── 用户上传到缓存 ───

    def save_upload(self, session_id: str, file_data: bytes, filename: str) -> Optional[Dict]:
        """保存用户上传的图片到缓存"""
        session_dir = os.path.join(CACHE_ROOT, session_id)
        if not os.path.isdir(session_dir):
            return None

        manifest = self._read_manifest(session_id)
        if not manifest:
            return None

        upload_count = sum(1 for img in manifest["images"] if img["source"] == "upload")
        ext = os.path.splitext(filename)[1].lower() or ".jpg"
        cache_filename = f"upload_{upload_count:03d}{ext}"
        filepath = os.path.join(session_dir, cache_filename)

        with open(filepath, "wb") as f:
            f.write(file_data)

        w, h = self._get_image_size(file_data)
        md5 = hashlib.md5(file_data).hexdigest()

        info = {
            "cache_file": cache_filename,
            "original_url": f"upload://{filename}",
            "source": "upload",
            "width": w or 0,
            "height": h or 0,
            "size_bytes": len(file_data),
            "md5": md5,
        }
        manifest["images"].append(info)
        self._write_manifest(session_id, manifest)
        return info

    # ─── 读取缓存文件 ───

    def get_file_path(self, session_id: str, filename: str) -> Optional[str]:
        """获取缓存文件的完整路径，不存在返回 None"""
        filepath = os.path.join(CACHE_ROOT, session_id, filename)
        if os.path.isfile(filepath):
            return filepath
        return None

    def read_file(self, session_id: str, filename: str) -> Optional[bytes]:
        """读取缓存文件内容"""
        filepath = self.get_file_path(session_id, filename)
        if not filepath:
            return None
        with open(filepath, "rb") as f:
            return f.read()

    def get_manifest(self, session_id: str) -> Optional[Dict]:
        """获取会话的图片清单"""
        return self._read_manifest(session_id)

    # ─── 清理缓存 ───

    def cleanup_session(self, session_id: str):
        """删除指定会话的缓存目录"""
        session_dir = os.path.join(CACHE_ROOT, session_id)
        if os.path.isdir(session_dir):
            shutil.rmtree(session_dir, ignore_errors=True)
            logger.info("[ImageCache] 已清理会话: %s", session_id)

    def cleanup_expired(self, max_age_hours: int = 24):
        """清理过期的缓存目录"""
        if not os.path.isdir(CACHE_ROOT):
            return
        now = datetime.utcnow()
        cleaned = 0
        for name in os.listdir(CACHE_ROOT):
            session_dir = os.path.join(CACHE_ROOT, name)
            if not os.path.isdir(session_dir):
                continue
            manifest = self._read_manifest(name)
            if manifest:
                try:
                    created = datetime.fromisoformat(manifest["created_at"])
                    if (now - created) > timedelta(hours=max_age_hours):
                        shutil.rmtree(session_dir, ignore_errors=True)
                        cleaned += 1
                except (ValueError, KeyError):
                    pass
            else:
                # 没有 manifest 的目录，检查目录修改时间
                mtime = datetime.utcfromtimestamp(os.path.getmtime(session_dir))
                if (now - mtime) > timedelta(hours=max_age_hours):
                    shutil.rmtree(session_dir, ignore_errors=True)
                    cleaned += 1
        if cleaned:
            logger.info("[ImageCache] 清理过期缓存: %d 个会话", cleaned)

    # ─── 内部方法 ───

    def _download_image(self, url: str, retries: int = 3) -> Optional[bytes]:
        """下载图片，带重试"""
        if not url or url.startswith("data:"):
            # data URL 直接解码
            if url and url.startswith("data:"):
                try:
                    import base64
                    _, b64data = url.split(",", 1)
                    return base64.b64decode(b64data)
                except Exception:
                    return None
            return None

        for attempt in range(retries):
            try:
                resp = requests.get(url, timeout=15, headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                    "Referer": url,
                    "Accept": "image/*,*/*;q=0.8",
                }, allow_redirects=True)
                resp.raise_for_status()
                ct = resp.headers.get("content-type", "")
                if "text/html" in ct:
                    return None
                if len(resp.content) < 1000:
                    return None
                return resp.content
            except Exception as e:
                if attempt < retries - 1:
                    import time
                    time.sleep(0.5)
                    continue
                logger.debug("[ImageCache] 下载失败 (%d次): %s -> %s", retries, url[:80], e)
                return None

    def _get_image_size(self, data: bytes):
        """获取图片宽高"""
        try:
            from PIL import Image
            import io
            img = Image.open(io.BytesIO(data))
            return img.size
        except Exception:
            return self._parse_dimensions(data)

    def _parse_dimensions(self, data: bytes):
        """从文件头解析宽高"""
        import struct
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
        if data[:8] == b'\x89PNG\r\n\x1a\n' and len(data) >= 24:
            w = struct.unpack('>I', data[16:20])[0]
            h = struct.unpack('>I', data[20:24])[0]
            return w, h
        if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
            if data[12:16] == b'VP8 ' and len(data) >= 30:
                w = struct.unpack('<H', data[26:28])[0] & 0x3FFF
                h = struct.unpack('<H', data[28:30])[0] & 0x3FFF
                return w, h
        return None, None

    def _get_ext(self, url: str, data: bytes) -> str:
        """判断图片扩展名"""
        if url.startswith("data:"):
            if "image/png" in url: return ".png"
            if "image/webp" in url: return ".webp"
            if "image/gif" in url: return ".gif"
        from urllib.parse import urlparse
        path = urlparse(url).path.lower()
        for ext in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
            if path.endswith(ext):
                return ext
        if data[:8] == b'\x89PNG\r\n\x1a\n':
            return ".png"
        if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
            return ".webp"
        return ".jpg"

    def _read_manifest(self, session_id: str) -> Optional[Dict]:
        path = os.path.join(CACHE_ROOT, session_id, "manifest.json")
        if not os.path.isfile(path):
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None

    def _write_manifest(self, session_id: str, manifest: Dict):
        path = os.path.join(CACHE_ROOT, session_id, "manifest.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)


# 单例
image_cache_service = ImageCacheService()
