"""
远程网站发布服务（CR-035 / CR-037）
通过 SSH 连接宝塔服务器，远程写入/删除文章文件。
自动检测网站架构类型，适配 5 种不同的文章管理方式。
"""
import hashlib
import json
import logging
import os
import re
from datetime import datetime
from io import BytesIO, StringIO
from typing import Optional, List
from urllib.parse import urlparse

import paramiko
import requests

from app.config import settings
from app.models.site import (
    SITE_TYPE_POSTS_ASSETS_JS, SITE_TYPE_POSTS_ASSETS,
    SITE_TYPE_ARTICLES_INDEX, SITE_TYPE_ARTICLES_INLINE,
    SITE_TYPE_ARTICLES_DATA_WINDOW, SITE_TYPE_BLOGPOSTS_DATA,
    SITE_TYPE_POSTS_SCRIPTS,
)

logger = logging.getLogger(__name__)


class RemotePublisher:
    """SSH 远程发布器：连接宝塔服务器操作文件"""

    def __init__(self):
        self.host = getattr(settings, "BT_SSH_HOST", "")
        self.port = int(getattr(settings, "BT_SSH_PORT", 22))
        self.user = getattr(settings, "BT_SSH_USER", "ubuntu")
        self.key_path = getattr(settings, "BT_SSH_KEY_PATH", "")
        self.password = getattr(settings, "BT_SSH_PASSWORD", "")

    def _connect(self) -> paramiko.SSHClient:
        """建立 SSH 连接"""
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        kwargs = {
            "hostname": self.host,
            "port": self.port,
            "username": self.user,
            "timeout": 15,
        }
        if self.key_path:
            kwargs["key_filename"] = self.key_path
        elif self.password:
            kwargs["password"] = self.password
        else:
            # 尝试默认密钥
            kwargs["look_for_keys"] = True
        client.connect(**kwargs)
        logger.info(f"SSH 已连接: {self.user}@{self.host}:{self.port}")
        return client

    def _sftp_read(self, sftp: paramiko.SFTPClient, path: str) -> str:
        """读取远程文件内容"""
        with sftp.open(path, "r") as f:
            return f.read().decode("utf-8")

    def _sftp_write(self, sftp: paramiko.SFTPClient, path: str, content: str):
        """写入远程文件"""
        with sftp.open(path, "w") as f:
            f.write(content.encode("utf-8"))

    def _ensure_dir(self, ssh: paramiko.SSHClient, path: str):
        """确保远程目录存在（同步等待完成）"""
        _, stdout, stderr = ssh.exec_command(f"mkdir -p {path}")
        stdout.channel.recv_exit_status()  # 阻塞等待命令完成

    def _bust_cache(self, sftp: paramiko.SFTPClient, site_root: str, site):
        """更新 HTML 文件中的 JS 缓存参数（?v=timestamp），强制 CDN 加载最新版本"""
        import time as _time
        ts = str(int(_time.time()))
        data_js = site.data_js_path or "js/articles-index.js"
        js_basename = data_js.rsplit("/", 1)[-1]
        cache_re = re.compile(re.escape(js_basename) + r"\?v=\d+")

        for html_name in ("article.html", "articles.html", "index.html", "category.html"):
            html_path = f"{site_root}/{html_name}"
            try:
                content = self._sftp_read(sftp, html_path)
            except Exception:
                continue
            if js_basename not in content:
                continue
            if cache_re.search(content):
                new_content = cache_re.sub(f"{js_basename}?v={ts}", content)
            else:
                new_content = content.replace(
                    f'{js_basename}"', f'{js_basename}?v={ts}"'
                ).replace(
                    f"{js_basename}'", f"{js_basename}?v={ts}'"
                )
            if new_content != content:
                self._sftp_write(sftp, html_path, new_content)
                logger.info(f"[Cache] 已更新 {html_name} 缓存参数: v={ts}")

    # ─── CR-037: 网站架构自动检测 ───

    def _remote_file_exists(self, sftp: paramiko.SFTPClient, path: str) -> bool:
        """检查远程文件是否存在"""
        try:
            sftp.stat(path)
            return True
        except FileNotFoundError:
            return False

    def _remote_dir_exists(self, sftp: paramiko.SFTPClient, path: str) -> bool:
        """检查远程目录是否存在"""
        try:
            import stat
            st = sftp.stat(path)
            return stat.S_ISDIR(st.st_mode)
        except (FileNotFoundError, IOError):
            return False

    def _remote_file_contains(self, sftp: paramiko.SFTPClient, path: str, keyword: str) -> bool:
        """检查远程文件是否包含指定关键词"""
        try:
            content = self._sftp_read(sftp, path)
            return keyword in content
        except Exception:
            return False

    def detect_site_type(self, site_path: str) -> dict:
        """
        SSH 连接宝塔服务器，自动检测网站的文章管理架构。
        返回 {site_type, data_js_path, article_var_name, article_html_pattern}
        """
        ssh = self._connect()
        try:
            sftp = ssh.open_sftp()
            result = self._detect_site_type_inner(sftp, site_path)
            sftp.close()
            return result
        finally:
            ssh.close()

    def _detect_site_type_inner(self, sftp: paramiko.SFTPClient, site_root: str) -> dict:
        """内部检测逻辑（已有 sftp 连接时使用）"""
        # A1: assets/js/main.js + const posts
        p = f"{site_root}/assets/js/main.js"
        if self._remote_file_exists(sftp, p) and self._remote_file_contains(sftp, p, "const posts"):
            return {
                "site_type": SITE_TYPE_POSTS_ASSETS_JS,
                "data_js_path": "assets/js/main.js",
                "article_var_name": "posts",
                "article_html_pattern": "post-{slug}.html",
            }

        # A2: assets/main.js + const posts
        p = f"{site_root}/assets/main.js"
        if self._remote_file_exists(sftp, p) and self._remote_file_contains(sftp, p, "const posts"):
            return {
                "site_type": SITE_TYPE_POSTS_ASSETS,
                "data_js_path": "assets/main.js",
                "article_var_name": "posts",
                "article_html_pattern": "post-{slug}.html",
            }

        # ── SPA 站点检测：article.html + JS 数据文件 ──
        has_article_html = self._remote_file_exists(sftp, f"{site_root}/article.html")
        has_articles_json_dir = self._remote_dir_exists(sftp, f"{site_root}/js/articles")

        # 检测 article.html 中的 URL 参数（?title= / ?slug= / ?id=）
        article_url_param = "title"  # 默认
        if has_article_html:
            try:
                main_js_path = f"{site_root}/js/main.js"
                if self._remote_file_exists(sftp, main_js_path):
                    main_content = self._sftp_read(sftp, main_js_path)
                    # 检测 URL 参数: urlParams.get('title') / get('slug') / get('id')
                    import re as _re
                    param_match = _re.search(
                        r"(?:urlParams|searchParams)\.get\(['\"](\w+)['\"]\).*?(?:article|Article|find|slug|title)",
                        main_content, _re.DOTALL
                    )
                    if not param_match:
                        # 更宽松的匹配
                        for candidate in ("slug", "title", "id"):
                            if f"get('{candidate}')" in main_content or f'get("{candidate}")' in main_content:
                                # 确认这个参数用于文章详情
                                idx = main_content.find(f"get('{candidate}')")
                                if idx < 0:
                                    idx = main_content.find(f'get("{candidate}")')
                                context = main_content[max(0, idx-200):idx+200].lower()
                                if "article" in context or "detail" in context or "slug" in context:
                                    article_url_param = candidate
                                    break
                    else:
                        article_url_param = param_match.group(1)
            except Exception:
                pass

        # B1-SPA: js/articles-index.js + articlesIndex (+ article.html SPA)
        p = f"{site_root}/js/articles-index.js"
        if self._remote_file_exists(sftp, p) and self._remote_file_contains(sftp, p, "articlesIndex"):
            pattern = f"article.html?{article_url_param}={{slug}}" if has_article_html else "article-{slug}.html"
            return {
                "site_type": SITE_TYPE_ARTICLES_INDEX,
                "data_js_path": "js/articles-index.js",
                "article_var_name": "articlesIndex",
                "article_html_pattern": pattern,
                "has_json_dir": has_articles_json_dir,
                "url_param": article_url_param,
            }

        # B2-SPA: js/data.js + const articles (独立数据文件，优先于 main.js)
        p = f"{site_root}/js/data.js"
        if self._remote_file_exists(sftp, p):
            content = ""
            try:
                content = self._sftp_read(sftp, p)
            except Exception:
                pass
            if "const articles " in content or "const articles=" in content:
                pattern = f"article.html?{article_url_param}={{slug}}" if has_article_html else "article-{slug}.html"
                return {
                    "site_type": SITE_TYPE_ARTICLES_INLINE,
                    "data_js_path": "js/data.js",
                    "article_var_name": "articles",
                    "article_html_pattern": pattern,
                    "has_json_dir": has_articles_json_dir,
                    "url_param": article_url_param,
                }

        # B2-fallback: js/main.js + const articles (内嵌在 main.js 中)
        p = f"{site_root}/js/main.js"
        if self._remote_file_exists(sftp, p):
            content = ""
            try:
                content = self._sftp_read(sftp, p)
            except Exception:
                pass
            if "const articles " in content or "const articles=" in content:
                pattern = f"article.html?{article_url_param}={{slug}}" if has_article_html else "article-{slug}.html"
                return {
                    "site_type": SITE_TYPE_ARTICLES_INLINE,
                    "data_js_path": "js/main.js",
                    "article_var_name": "articles",
                    "article_html_pattern": pattern,
                    "has_json_dir": has_articles_json_dir,
                    "url_param": article_url_param,
                }
            if "const articlesData " in content or "const articlesData=" in content:
                pattern = f"article.html?{article_url_param}={{slug}}" if has_article_html else "article-{slug}.html"
                return {
                    "site_type": SITE_TYPE_ARTICLES_INLINE,
                    "data_js_path": "js/main.js",
                    "article_var_name": "articlesData",
                    "article_html_pattern": pattern,
                    "has_json_dir": has_articles_json_dir,
                    "url_param": article_url_param,
                }

        # C1: articles-data.js + window.__ARTICLES__
        p = f"{site_root}/articles-data.js"
        if self._remote_file_exists(sftp, p):
            return {
                "site_type": SITE_TYPE_ARTICLES_DATA_WINDOW,
                "data_js_path": "articles-data.js",
                "article_var_name": "__ARTICLES__",
                "article_html_pattern": "article-{slug}.html",
            }

        # C2: data.js + const blogPosts
        p = f"{site_root}/data.js"
        if self._remote_file_exists(sftp, p) and self._remote_file_contains(sftp, p, "blogPosts"):
            return {
                "site_type": SITE_TYPE_BLOGPOSTS_DATA,
                "data_js_path": "data.js",
                "article_var_name": "blogPosts",
                "article_html_pattern": "article-{slug}.html",
            }

        # D: scripts.js + const POSTS
        p = f"{site_root}/scripts.js"
        if self._remote_file_exists(sftp, p) and self._remote_file_contains(sftp, p, "const POSTS"):
            return {
                "site_type": SITE_TYPE_POSTS_SCRIPTS,
                "data_js_path": "scripts.js",
                "article_var_name": "POSTS",
                "article_html_pattern": "post-{slug}.html",
            }

        # 未知架构
        return {
            "site_type": None,
            "data_js_path": None,
            "article_var_name": None,
            "article_html_pattern": None,
        }

    def _download_image(self, url: str, retries: int = 2,
                        min_width: int = 800, min_height: int = 600) -> Optional[bytes]:
        """从外部 URL 下载图片，返回二进制数据（带重试）。支持 data URL (base64)
        下载后验证实际分辨率，低于 min_width x min_height 的图片返回 None。
        """
        if not url:
            return None
        # 处理 data URL (base64 内联图片)
        if url.startswith('data:'):
            try:
                import base64 as _b64
                # data:image/png;base64,iVBOR...
                header, b64data = url.split(',', 1)
                data = _b64.b64decode(b64data)
                if not self._check_image_quality(data, url, min_width, min_height):
                    return None
                return data
            except Exception as e:
                logger.warning(f"data URL 解码失败: {e}")
                return None
        for attempt in range(retries + 1):
            try:
                resp = requests.get(url, timeout=20, headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                    "Referer": url,
                    "Accept": "image/*,*/*;q=0.8",
                }, allow_redirects=True)
                resp.raise_for_status()
                content_type = resp.headers.get("content-type", "")
                if len(resp.content) < 2000:
                    logger.warning(f"图片太小 ({len(resp.content)} bytes)，可能无效: {url}")
                    return None
                if "text/html" in content_type:
                    logger.warning(f"图片 URL 返回 HTML 而非图片: {url}")
                    return None
                # 验证实际分辨率和质量
                if not self._check_image_quality(resp.content, url, min_width, min_height):
                    return None
                return resp.content
            except Exception as e:
                if attempt < retries:
                    import time
                    time.sleep(1)
                    continue
                logger.warning(f"图片下载失败 (尝试{attempt+1}次): {url} -> {e}")
                return None

    def _check_image_quality(self, data: bytes, url: str,
                             min_width: int = 800, min_height: int = 600) -> bool:
        """检查图片实际分辨率和模糊度，拒绝低质量图片"""
        try:
            from PIL import Image
            import io
            img = Image.open(io.BytesIO(data))
            w, h = img.size
            # 分辨率检查
            if w < min_width or h < min_height:
                logger.warning(f"图片分辨率过低 ({w}x{h} < {min_width}x{min_height})，跳过: {url}")
                return False
            # 文件大小与像素比 — 极低比值说明严重压缩/模糊
            pixels = w * h
            bytes_per_pixel = len(data) / pixels if pixels > 0 else 0
            if bytes_per_pixel < 0.05 and len(data) < 15000:
                logger.warning(f"图片疑似模糊 (bpp={bytes_per_pixel:.3f}, size={len(data)}B, {w}x{h})，跳过: {url}")
                return False
            # 灰度方差检测模糊度（可选，仅对 RGB 图）
            if img.mode in ('RGB', 'RGBA') and w <= 4000 and h <= 4000:
                try:
                    gray = img.convert('L')
                    import numpy as np
                    arr = np.array(gray, dtype=np.float64)
                    # Laplacian 方差 — 值越低越模糊
                    laplacian = np.array([[0, 1, 0], [1, -4, 1], [0, 1, 0]], dtype=np.float64)
                    from scipy.signal import convolve2d
                    lap = convolve2d(arr, laplacian, mode='valid')
                    variance = lap.var()
                    if variance < 50:
                        logger.warning(f"图片模糊度过高 (laplacian_var={variance:.1f})，跳过: {url}")
                        return False
                except ImportError:
                    pass  # numpy/scipy 不可用时跳过模糊检测
                except Exception:
                    pass  # 其他异常不阻塞
            logger.info(f"图片质量通过 ({w}x{h}, {len(data)/1024:.0f}KB): {url[:80]}")
            return True
        except Exception as e:
            logger.warning(f"图片质量检查失败，放行: {url} -> {e}")
            return True  # 无法检查时放行

    def _upload_image(self, sftp: paramiko.SFTPClient, ssh: paramiko.SSHClient,
                      data: bytes, remote_path: str):
        """上传图片到远程服务器"""
        remote_dir = os.path.dirname(remote_path)
        _, stdout, stderr = ssh.exec_command(f"mkdir -p {remote_dir}")
        stdout.channel.recv_exit_status()  # 阻塞等待 mkdir 完成
        with sftp.open(remote_path, "wb") as f:
            f.write(data)

    def _get_image_ext(self, url: str, data: bytes) -> str:
        """根据 URL 或文件头判断图片扩展名"""
        # data URL: 从 MIME 类型提取
        if url.startswith('data:'):
            if 'image/png' in url: return '.png'
            if 'image/gif' in url: return '.gif'
            if 'image/webp' in url: return '.webp'
            if 'image/svg' in url: return '.svg'
            # 默认按文件头判断
        parsed = urlparse(url)
        path = parsed.path.lower()
        for ext in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"):
            if path.endswith(ext):
                return ext
        if data[:8] == b'\x89PNG\r\n\x1a\n':
            return ".png"
        if data[:2] == b'\xff\xd8':
            return ".jpg"
        if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
            return ".webp"
        return ".jpg"

    def _process_images(self, ssh, sftp, site_root: str, slug: str,
                        featured_image: str, content_images: List[str]) -> dict:
        """下载并上传所有图片到宝塔服务器，返回本地路径映射"""
        img_dir = f"{site_root}/image/post-{slug}"
        result = {"hero": None, "content": []}

        if featured_image:
            # hero 图放宽要求：宽>=600, 高>=300 即可（横幅图高度通常较低）
            data = self._download_image(featured_image, min_width=600, min_height=300)
            if data:
                ext = self._get_image_ext(featured_image, data)
                remote_path = f"{img_dir}/hero{ext}"
                self._upload_image(sftp, ssh, data, remote_path)
                result["hero"] = f"image/post-{slug}/hero{ext}"
                logger.info(f"头图已上传: {remote_path} ({len(data)} bytes)")
            else:
                result["hero"] = featured_image

        for i, img_url in enumerate(content_images):
            if not img_url:
                continue
            data = self._download_image(img_url)
            if data:
                ext = self._get_image_ext(img_url, data)
                remote_path = f"{img_dir}/content-{i+1}{ext}"
                self._upload_image(sftp, ssh, data, remote_path)
                result["content"].append(f"image/post-{slug}/content-{i+1}{ext}")
                logger.info(f"内容图 {i+1} 已上传: {remote_path}")
            else:
                logger.warning(f"内容图 {i+1} 下载失败，跳过: {img_url}")

        return result

    def _insert_content_images(self, content_html: str, image_paths: List[str]) -> str:
        """将内容图片分散插入到文章段落之间（优先 h2，不足时用 p/h3 作为插入点）"""
        if not image_paths:
            return content_html

        def _make_img_tag(path):
            return (
                f'\n            <div class="ab-page-hero-img">\n'
                f'              <img\n'
                f'                src="{path}"\n'
                f'                alt="Article illustration"\n'
                f'                loading="lazy"\n'
                f'              />\n'
                f'            </div>\n\n'
            )

        # 收集所有可用的插入点：h2 > h3 > p（跳过第一个段落）
        h2_positions = [m.start() for m in re.finditer(r'<h2[^>]*>', content_html)]
        h3_positions = [m.start() for m in re.finditer(r'<h3[^>]*>', content_html)]
        p_positions = [m.start() for m in re.finditer(r'</p>', content_html)]

        # 合并插入点：优先 h2，不够用 h3，再不够用段落间
        all_points = []
        for pos in h2_positions:
            all_points.append((pos, 'h2'))
        for pos in h3_positions:
            all_points.append((pos, 'h3'))
        # p 标签只取偶数位（每隔一段插一张，避免太密集）
        for idx, pos in enumerate(p_positions):
            if idx > 0 and idx % 2 == 0:  # 跳过第一段，每隔2段
                all_points.append((pos + 4, 'p'))  # +4 跳过 </p>
        all_points.sort(key=lambda x: x[0])

        # 去重：相邻 50 字符内的插入点只保留一个
        filtered = []
        last = -100
        for pos, tag in all_points:
            if pos - last > 50:
                filtered.append(pos)
                last = pos

        if not filtered:
            # 完全没有插入点，追加到末尾
            img_block = "\n".join(_make_img_tag(p) for p in image_paths)
            return content_html + "\n" + img_block

        # 均匀分配图片到插入点
        step = max(1, len(filtered) // (len(image_paths) + 1))
        insert_map = {}  # pos -> image_path
        for i, img_path in enumerate(image_paths):
            idx = min((i + 1) * step, len(filtered) - 1)
            pos = filtered[idx]
            # 避免同一位置插入多张
            while pos in insert_map and idx < len(filtered) - 1:
                idx += 1
                pos = filtered[idx]
            insert_map[pos] = img_path

        # 按位置倒序插入（避免偏移）
        result = content_html
        for pos in sorted(insert_map.keys(), reverse=True):
            result = result[:pos] + _make_img_tag(insert_map[pos]) + result[pos:]

        return result

    def publish_article(self, site, article) -> dict:
        """
        发布文章到宝塔服务器（CR-037: 按 site_type 分发）。
        自动检测架构类型并调用对应的发布方法。
        """
        site_root = site.site_path
        slug = article.slug
        site_type = site.site_type

        ssh = self._connect()
        try:
            sftp = ssh.open_sftp()

            # 如果 site_type 为空，先自动检测并保存
            detected_config = None
            if not site_type:
                detected_config = self._detect_site_type_inner(sftp, site_root)
                site_type = detected_config.get("site_type")
                logger.info(f"[发布] 自动检测 {site.domain} 架构: {site_type}")
                if not site_type:
                    raise ValueError(f"无法识别网站 {site.domain} 的文章架构，请检查网站目录结构")

            # 处理图片（所有类型通用）
            content_image_urls = []
            if hasattr(article, "images") and article.images:
                sorted_imgs = sorted(article.images, key=lambda x: (x.position or 0))
                content_image_urls = [img.url for img in sorted_imgs if img.url]

            # 兜底：如果没有内容图片，自动从标题/商家搜索 4 张高清图
            if len(content_image_urls) < 4:
                try:
                    from app.services.merchant_crawler import search_images as search_merchant_images
                    # 提取品牌名和品类用于精准搜索
                    brand = getattr(article, "merchant_url", "") or ""
                    if brand:
                        # 从 URL 提取域名作为品牌名
                        from urllib.parse import urlparse as _urlparse
                        _parsed = _urlparse(brand)
                        brand = _parsed.netloc.replace("www.", "").split(".")[0] if _parsed.netloc else brand
                    category = getattr(article, "category_name", "") or ""
                    search_query = ""
                    if hasattr(article, "meta_keywords") and article.meta_keywords:
                        search_query = article.meta_keywords.split(",")[0].strip()
                    elif article.title:
                        search_query = article.title
                    need = 4 - len(content_image_urls)
                    # 使用改进的多轮搜索策略
                    extra = search_merchant_images(
                        search_query, count=need + 8,
                        brand_name=brand, category=category
                    )
                    existing_set = set(content_image_urls)
                    for img_url in extra:
                        if img_url not in existing_set and len(content_image_urls) < 4:
                            content_image_urls.append(img_url)
                            existing_set.add(img_url)
                    logger.info(f"[发布] 自动补充高清内容图: 需要{need}张, 最终{len(content_image_urls)}张 (brand={brand}, cat={category})")
                except Exception as e:
                    logger.warning(f"[发布] 自动搜索内容图片失败: {e}")

            image_paths = self._process_images(
                ssh, sftp, site_root, slug,
                article.featured_image or "",
                content_image_urls,
            )

            # 按架构类型分发
            if site_type in (SITE_TYPE_POSTS_ASSETS_JS, SITE_TYPE_POSTS_ASSETS, SITE_TYPE_POSTS_SCRIPTS):
                result = self._publish_posts_type(ssh, sftp, site, article, image_paths, site_type)
            elif site_type == SITE_TYPE_ARTICLES_INDEX:
                result = self._publish_articles_index_type(ssh, sftp, site, article, image_paths)
            elif site_type == SITE_TYPE_ARTICLES_INLINE:
                result = self._publish_articles_inline_type(ssh, sftp, site, article, image_paths)
            elif site_type in (SITE_TYPE_ARTICLES_DATA_WINDOW, SITE_TYPE_BLOGPOSTS_DATA):
                result = self._publish_articles_data_type(ssh, sftp, site, article, image_paths, site_type)
            else:
                raise ValueError(f"不支持的网站架构类型: {site_type}")

            # 更新 HTML 文件的缓存参数，强制 CDN/浏览器加载最新数据
            self._bust_cache(sftp, site_root, site)

            sftp.close()
            logger.info(f"文章已远程发布: slug={slug}, site={site.site_name}, type={site_type}, "
                        f"images: hero={'yes' if image_paths['hero'] else 'no'}, "
                        f"content={len(image_paths['content'])}")

            # 附带 article_html_pattern 供调用者构造正确 URL
            pattern = site.article_html_pattern
            if not pattern and detected_config:
                pattern = detected_config.get("article_html_pattern")
            if pattern:
                result["article_html_pattern"] = pattern
            if detected_config:
                result["detected_config"] = detected_config

            return result
        finally:
            ssh.close()

    # ─── 各架构类型的发布实现 ───

    def _publish_posts_type(self, ssh, sftp, site, article, image_paths, site_type) -> dict:
        """A1/A2/D 类型: 操作 const posts / const POSTS / window.VERVE_POSTS 数组"""
        site_root = site.site_path
        slug = article.slug

        # 优先使用数据库中的配置，回退到硬编码默认值
        if site.data_js_path and site.article_var_name:
            data_path = f"{site_root}/{site.data_js_path}"
            var_name = site.article_var_name
        elif site_type == SITE_TYPE_POSTS_ASSETS_JS:
            data_path = f"{site_root}/assets/js/main.js"
            var_name = "posts"
        elif site_type == SITE_TYPE_POSTS_ASSETS:
            data_path = f"{site_root}/assets/main.js"
            var_name = "posts"
        else:  # SITE_TYPE_POSTS_SCRIPTS
            data_path = f"{site_root}/scripts.js"
            var_name = "POSTS"

        main_js_content = self._sftp_read(sftp, data_path)
        posts = self._parse_js_array(main_js_content, var_name)

        if any(p.get("slug") == slug or p.get("url", "").endswith(f"{slug}.html") for p in posts):
            raise ValueError(f"slug '{slug}' 已存在于网站 {var_name} 中")

        new_id = max((p.get("id", 0) for p in posts), default=0) + 1
        new_post = self._build_post_entry(article, new_id, image_paths, slug,
                                          existing_posts=posts)

        posts.insert(0, new_post)
        new_content = self._rebuild_js_array(main_js_content, var_name, posts)
        self._sftp_write(sftp, data_path, new_content)

        # 生成文章详情页 HTML
        category_name = self._get_category_name(article)
        date_label, read_time = self._get_date_and_readtime(article)
        html_content = self._generate_article_html(
            article, category_name, date_label, read_time,
            hero_path=image_paths["hero"],
            content_image_paths=image_paths["content"],
        )
        html_path = f"{site_root}/post-{slug}.html"
        self._sftp_write(sftp, html_path, html_content)

        return {"site_article_slug": slug, "site_article_id": new_id}

    def _publish_articles_index_type(self, ssh, sftp, site, article, image_paths) -> dict:
        """B1 类型: 操作 articlesIndex 数组 + 生成 js/articles/{id}.json"""
        site_root = site.site_path
        slug = article.slug
        data_path = f"{site_root}/{site.data_js_path or 'js/articles-index.js'}"

        content = self._sftp_read(sftp, data_path)
        articles_list = self._parse_js_array(content, "articlesIndex")

        # 检查重复
        if any(a.get("slug") == slug or str(a.get("id")) == slug for a in articles_list):
            raise ValueError(f"slug '{slug}' 已存在于 articlesIndex 中")

        # 计算新 ID：取 articlesIndex 和已有 JSON 文件中的最大 ID + 1
        max_index_id = max((a.get("id", 0) for a in articles_list if isinstance(a.get("id"), int)), default=0)
        max_json_id = 0
        js_articles_dir = f"{site_root}/js/articles"
        if self._remote_dir_exists(sftp, js_articles_dir):
            try:
                for fname in sftp.listdir(js_articles_dir):
                    if fname.endswith('.json'):
                        try:
                            fid = int(fname.replace('.json', ''))
                            max_json_id = max(max_json_id, fid)
                        except ValueError:
                            pass
            except Exception:
                pass
        new_id = max(max_index_id, max_json_id) + 1

        category_name = self._get_category_name(article)
        date_label, read_time = self._get_date_and_readtime(article)
        created = self._get_article_date(article)

        index_entry = {
            "id": new_id,
            "slug": slug,
            "title": article.title,
            "category": (category_name or "general").lower().replace(" & ", "-").replace(" ", "-"),
            "categoryName": category_name,
            "date": created.strftime("%Y-%m-%d"),
            "image": image_paths["hero"] or article.featured_image or "",
            "excerpt": article.excerpt or "",
            "hasProducts": False,
        }

        articles_list.insert(0, index_entry)
        new_content = self._rebuild_js_array(content, "articlesIndex", articles_list)
        self._sftp_write(sftp, data_path, new_content)

        # 生成 JSON 详情文件（始终使用 js/articles/{id}.json）
        articles_dir = f"{site_root}/articles"
        if not self._remote_dir_exists(sftp, js_articles_dir):
            target_dir = articles_dir
            json_path = f"{articles_dir}/{slug}.json"
        else:
            target_dir = js_articles_dir
            json_path = f"{js_articles_dir}/{new_id}.json"
        self._ensure_dir(ssh, target_dir)

        content_html = article.content or ""
        if image_paths["content"]:
            content_html = self._insert_content_images(content_html, image_paths["content"])

        detail_json = {
            "id": new_id,
            "slug": slug,
            "title": article.title,
            "category": index_entry["category"],
            "categoryName": category_name,
            "date": index_entry["date"],
            "author": getattr(article, "author_name", None) or "Editorial Team",
            "image": index_entry["image"],
            "excerpt": article.excerpt or "",
            "content": content_html,
            "products": [],
        }
        json_path_final = json_path  # 使用上面检测到的正确路径
        self._sftp_write(sftp, json_path_final, json.dumps(detail_json, ensure_ascii=False, indent=2))

        logger.info(f"[B1] 已写入 articlesIndex + {json_path_final}")

        # ── 双数据源站点：同步更新 script.js 中的 articlesData / blogPosts ──
        # BloomRoots: script.js 有 const articlesData（含完整 content 数组）
        # Quiblo: script.js 有 const blogPosts（含完整 content）
        for script_name, var_candidates in [("script.js", ["articlesData", "blogPosts"])]:
            script_path = f"{site_root}/{script_name}"
            if not self._remote_file_exists(sftp, script_path):
                continue
            try:
                script_content = self._sftp_read(sftp, script_path)
                for var in var_candidates:
                    if f"const {var}" not in script_content and f"let {var}" not in script_content:
                        continue
                    # 解析现有数组
                    try:
                        existing = self._parse_js_array(script_content, var)
                    except ValueError:
                        continue
                    # 检查是否已存在
                    if any(a.get("title") == article.title for a in existing):
                        logger.info(f"[B1] {script_name}/{var} 已有此文章，跳过")
                        continue
                    # 构建完整条目（含 content 数组）
                    full_entry = {
                        "id": new_id,
                        "title": article.title,
                        "category": index_entry["category"],
                        "categoryName": category_name,
                        "excerpt": article.excerpt or "",
                        "heroImage": index_entry["image"],
                        "date": index_entry["date"],
                        "author": getattr(article, "author_name", None) or "Editorial Team",
                        "products": [],
                    }
                    # 检测已有条目的字段格式来适配
                    if existing:
                        sample = existing[0]
                        if "image" in sample and "heroImage" not in sample:
                            full_entry["image"] = full_entry.pop("heroImage")
                        if "featured" in sample:
                            full_entry["featured"] = True
                        if "content" in sample and isinstance(sample["content"], list):
                            # content 是段落数组格式
                            paragraphs = []
                            if content_html:
                                import re as _re
                                # 从 HTML 提取段落文本
                                for p_match in _re.finditer(r'<(?:p|h[23])[^>]*>(.*?)</(?:p|h[23])>', content_html, _re.DOTALL):
                                    text = _re.sub(r'<[^>]+>', '', p_match.group(1)).strip()
                                    if text:
                                        paragraphs.append(text)
                            full_entry["content"] = paragraphs if paragraphs else [content_html]
                        elif "content" in sample:
                            full_entry["content"] = content_html
                    existing.insert(0, full_entry)
                    new_script = self._rebuild_js_array(script_content, var, existing)
                    self._sftp_write(sftp, script_path, new_script)
                    logger.info(f"[B1] 同步更新 {script_name}/{var} (+1 条)")
                    break  # 只更新第一个匹配的变量
            except Exception as e:
                logger.warning(f"[B1] 同步 {script_name} 失败: {e}")

        # ── 防止 articles-index.js 与 script.js 变量冲突 ──
        # 重新读取写入后的 articles-index.js，确保没有重复声明 script.js 中的变量
        try:
            final_idx = self._sftp_read(sftp, data_path)
            needs_rewrite = False
            for conflict_var in ["articlesData", "blogPosts"]:
                # 检查 script.js 是否声明了此变量
                script_path = f"{site_root}/script.js"
                if self._remote_file_exists(sftp, script_path):
                    script_content = self._sftp_read(sftp, script_path)
                    if f"const {conflict_var}" in script_content or f"let {conflict_var}" in script_content or f"var {conflict_var}" in script_content:
                        # articles-index.js 不能用 const/let 再声明同名变量
                        if f"const {conflict_var}" in final_idx:
                            final_idx = final_idx.replace(f"const {conflict_var}", f"var {conflict_var}")
                            needs_rewrite = True
                        if f"let {conflict_var}" in final_idx:
                            final_idx = final_idx.replace(f"let {conflict_var}", f"var {conflict_var}")
                            needs_rewrite = True
            if needs_rewrite:
                self._sftp_write(sftp, data_path, final_idx)
                logger.info("[B1] 已修复 articles-index.js 变量冲突")
        except Exception as e:
            logger.warning(f"[B1] 变量冲突检查失败: {e}")

        return {"site_article_slug": slug, "site_article_id": new_id}

    def _publish_articles_inline_type(self, ssh, sftp, site, article, image_paths) -> dict:
        """B2 类型: 操作 js/main.js 中内嵌的 const articles / const articlesData"""
        site_root = site.site_path
        slug = article.slug
        var_name = site.article_var_name or "articles"
        data_path = f"{site_root}/{site.data_js_path or 'js/main.js'}"

        content = self._sftp_read(sftp, data_path)
        articles_list = self._parse_js_array(content, var_name)

        if any(a.get("slug") == slug for a in articles_list):
            raise ValueError(f"slug '{slug}' 已存在于 {var_name} 中")

        new_id = max((a.get("id", 0) for a in articles_list if isinstance(a.get("id"), int)), default=0) + 1
        category_name = self._get_category_name(article)
        date_label, read_time = self._get_date_and_readtime(article)
        created = self._get_article_date(article)

        content_html = article.content or ""
        if image_paths["content"]:
            content_html = self._insert_content_images(content_html, image_paths["content"])

        new_entry = {
            "id": new_id,
            "slug": slug,
            "title": article.title,
            "category": (category_name or "general").lower().replace(" & ", "-").replace(" ", "-"),
            "date": created.strftime("%B %d, %Y"),
            "image": image_paths["hero"] or article.featured_image or "",
            "excerpt": article.excerpt or "",
            "content": content_html,
        }

        articles_list.insert(0, new_entry)
        new_content = self._rebuild_js_array(content, var_name, articles_list)
        self._sftp_write(sftp, data_path, new_content)

        logger.info(f"[B2] 已写入 {var_name} 内嵌数组")
        return {"site_article_slug": slug, "site_article_id": new_id}

    def _publish_articles_data_type(self, ssh, sftp, site, article, image_paths, site_type) -> dict:
        """C 类型: 操作 articles-data.js (window.__ARTICLES__) 或 data.js (blogPosts)"""
        site_root = site.site_path
        slug = article.slug
        category_name = self._get_category_name(article)
        date_label, read_time = self._get_date_and_readtime(article)
        created = self._get_article_date(article)

        content_html = article.content or ""
        if image_paths["content"]:
            content_html = self._insert_content_images(content_html, image_paths["content"])

        if site_type == SITE_TYPE_ARTICLES_DATA_WINDOW:
            # C1: window.__ARTICLES__ = [...]
            data_path = f"{site_root}/articles-data.js"
            raw = self._sftp_read(sftp, data_path)

            # 解析 JSON 数组
            match = re.search(r'window\.__ARTICLES__\s*=\s*(\[[\s\S]*\])', raw)
            if not match:
                raise ValueError("无法解析 articles-data.js 中的 window.__ARTICLES__")
            arr = json.loads(match.group(1))

            new_id = max((a.get("id", 0) for a in arr), default=0) + 1
            new_entry = {
                "id": new_id,
                "title": article.title,
                "category": (category_name or "general").lower(),
                "categoryName": category_name,
                "date": created.strftime("%Y-%m-%d"),
                "author": getattr(article, "author_name", None) or "Editorial Team",
                "image": image_paths["hero"] or article.featured_image or "",
                "excerpt": article.excerpt or "",
                "content": content_html,
            }
            arr.insert(0, new_entry)
            new_raw = "window.__ARTICLES__ = " + json.dumps(arr, ensure_ascii=False, indent=2) + ";\n"
            self._sftp_write(sftp, data_path, new_raw)
            logger.info(f"[C1] 已写入 window.__ARTICLES__")
            return {"site_article_slug": slug, "site_article_id": new_id}

        else:
            # C2: const blogPosts = [...]
            data_path = f"{site_root}/data.js"
            raw = self._sftp_read(sftp, data_path)
            arr = self._parse_js_array(raw, "blogPosts")

            new_id = max((a.get("id", 0) for a in arr if isinstance(a.get("id"), int)), default=0) + 1
            new_entry = {
                "id": new_id,
                "slug": slug,
                "title": article.title,
                "category": (category_name or "general").lower(),
                "date": created.strftime("%Y-%m-%d"),
                "featured": False,
                "excerpt": article.excerpt or "",
                "image": image_paths["hero"] or article.featured_image or "",
                "content": content_html,
            }
            arr.insert(0, new_entry)
            new_raw = self._rebuild_js_array(raw, "blogPosts", arr)
            self._sftp_write(sftp, data_path, new_raw)
            logger.info(f"[C2] 已写入 blogPosts")
            return {"site_article_slug": slug, "site_article_id": new_id}

    def unpublish_article(self, site, slug: str):
        """
        从宝塔服务器移除文章（CR-037: 按 site_type 分发）
        """
        site_root = site.site_path
        site_type = site.site_type

        ssh = self._connect()
        try:
            sftp = ssh.open_sftp()

            # 如果 site_type 为空，自动检测
            if not site_type:
                detected = self._detect_site_type_inner(sftp, site_root)
                site_type = detected.get("site_type")

            if site_type in (SITE_TYPE_POSTS_ASSETS_JS, SITE_TYPE_POSTS_ASSETS, SITE_TYPE_POSTS_SCRIPTS):
                self._unpublish_posts_type(sftp, site, slug, site_type)
            elif site_type == SITE_TYPE_ARTICLES_INDEX:
                self._unpublish_articles_index_type(sftp, site, slug)
            elif site_type == SITE_TYPE_ARTICLES_INLINE:
                self._unpublish_articles_inline_type(sftp, site, slug)
            elif site_type in (SITE_TYPE_ARTICLES_DATA_WINDOW, SITE_TYPE_BLOGPOSTS_DATA):
                self._unpublish_articles_data_type(sftp, site, slug, site_type)
            else:
                logger.warning(f"未知 site_type={site_type}，尝试通用移除")
                self._unpublish_generic(sftp, site_root, slug)

            sftp.close()
            logger.info(f"文章已远程移除: slug={slug}, site={site.site_name}, type={site_type}")
        finally:
            ssh.close()

    def _unpublish_posts_type(self, sftp, site, slug, site_type):
        """A1/A2/D: 从 posts/POSTS/VERVE_POSTS 数组移除 + 删除 HTML"""
        site_root = site.site_path
        if site.data_js_path and site.article_var_name:
            data_path = f"{site_root}/{site.data_js_path}"
            var_name = site.article_var_name
        elif site_type == SITE_TYPE_POSTS_ASSETS_JS:
            data_path = f"{site_root}/assets/js/main.js"
            var_name = "posts"
        elif site_type == SITE_TYPE_POSTS_ASSETS:
            data_path = f"{site_root}/assets/main.js"
            var_name = "posts"
        else:
            data_path = f"{site_root}/scripts.js"
            var_name = "POSTS"

        content = self._sftp_read(sftp, data_path)
        arr = self._parse_js_array(content, var_name)
        arr = [p for p in arr if p.get("slug") != slug]
        new_content = self._rebuild_js_array(content, var_name, arr)
        self._sftp_write(sftp, data_path, new_content)

        try:
            sftp.remove(f"{site_root}/post-{slug}.html")
        except FileNotFoundError:
            logger.warning(f"文章 HTML 不存在: post-{slug}.html")

    def _unpublish_articles_index_type(self, sftp, site, slug):
        """B1: 从 articlesIndex 移除 + 删除 JSON 详情文件"""
        site_root = site.site_path
        data_path = f"{site_root}/{site.data_js_path or 'js/articles-index.js'}"

        content = self._sftp_read(sftp, data_path)
        arr = self._parse_js_array(content, "articlesIndex")
        arr = [a for a in arr if a.get("slug") != slug and str(a.get("id")) != slug]
        new_content = self._rebuild_js_array(content, "articlesIndex", arr)
        self._sftp_write(sftp, data_path, new_content)

        try:
            sftp.remove(f"{site_root}/js/articles/{slug}.json")
        except FileNotFoundError:
            pass
        # Also try by finding the article ID from the removed entry
        removed = [a for a in self._parse_js_array(content, "articlesIndex") if a.get("slug") == slug]
        if removed:
            aid = removed[0].get("id")
            if aid:
                try:
                    sftp.remove(f"{site_root}/js/articles/{aid}.json")
                except FileNotFoundError:
                    pass
        try:
            sftp.remove(f"{site_root}/articles/{slug}.json")
        except FileNotFoundError:
            logger.debug(f"文章 JSON 不存在: articles/{slug}.json")

    def _unpublish_articles_inline_type(self, sftp, site, slug):
        """B2: 从内嵌数组移除"""
        site_root = site.site_path
        var_name = site.article_var_name or "articles"
        data_path = f"{site_root}/{site.data_js_path or 'js/main.js'}"

        content = self._sftp_read(sftp, data_path)
        arr = self._parse_js_array(content, var_name)
        arr = [a for a in arr if a.get("slug") != slug]
        new_content = self._rebuild_js_array(content, var_name, arr)
        self._sftp_write(sftp, data_path, new_content)

    def _unpublish_articles_data_type(self, sftp, site, slug, site_type):
        """C: 从 window.__ARTICLES__ 或 blogPosts 移除"""
        site_root = site.site_path

        if site_type == SITE_TYPE_ARTICLES_DATA_WINDOW:
            data_path = f"{site_root}/articles-data.js"
            raw = self._sftp_read(sftp, data_path)
            match = re.search(r'window\.__ARTICLES__\s*=\s*(\[[\s\S]*\])', raw)
            if match:
                arr = json.loads(match.group(1))
                arr = [a for a in arr if a.get("title") != slug and str(a.get("id")) != slug]
                new_raw = "window.__ARTICLES__ = " + json.dumps(arr, ensure_ascii=False, indent=2) + ";\n"
                self._sftp_write(sftp, data_path, new_raw)
        else:
            data_path = f"{site_root}/data.js"
            raw = self._sftp_read(sftp, data_path)
            arr = self._parse_js_array(raw, "blogPosts")
            arr = [a for a in arr if a.get("slug") != slug]
            new_raw = self._rebuild_js_array(raw, "blogPosts", arr)
            self._sftp_write(sftp, data_path, new_raw)

    def _unpublish_generic(self, sftp, site_root, slug):
        """通用移除: 尝试删除常见文件名"""
        for pattern in [f"post-{slug}.html", f"article-{slug}.html"]:
            try:
                sftp.remove(f"{site_root}/{pattern}")
                logger.info(f"已删除: {pattern}")
            except FileNotFoundError:
                pass

    def verify_connection(self, site_path: str) -> dict:
        """验证 SSH 连接和网站目录，同时检测架构类型"""
        try:
            ssh = self._connect()
            sftp = ssh.open_sftp()
            checks = {
                "ssh_connected": True,
                "site_dir_exists": False,
                "main_js_exists": False,
                "index_html_exists": False,
                "site_type": None,
            }
            try:
                sftp.stat(site_path)
                checks["site_dir_exists"] = True
            except FileNotFoundError:
                pass

            # 检测架构类型
            if checks["site_dir_exists"]:
                detected = self._detect_site_type_inner(sftp, site_path)
                checks["site_type"] = detected.get("site_type")
                checks["data_js_path"] = detected.get("data_js_path")
                checks["article_var_name"] = detected.get("article_var_name")
                checks["article_html_pattern"] = detected.get("article_html_pattern")
                # main_js_exists 根据检测到的数据文件判断
                if detected.get("data_js_path"):
                    checks["main_js_exists"] = True

            try:
                sftp.stat(f"{site_path}/index.html")
                checks["index_html_exists"] = True
            except FileNotFoundError:
                pass
            checks["valid"] = checks["ssh_connected"] and checks["site_dir_exists"] and checks["index_html_exists"]
            sftp.close()
            ssh.close()
            return checks
        except Exception as e:
            return {
                "ssh_connected": False,
                "error": str(e),
                "valid": False,
            }

    # ─── 通用辅助方法 ───

    def _get_category_name(self, article) -> str:
        if article.category and hasattr(article.category, "name"):
            return article.category.name
        return "General"

    def _get_article_date(self, article):
        """优先使用 publish_date（支持回溯发布），回退到 created_at"""
        if hasattr(article, "publish_date") and article.publish_date:
            return article.publish_date
        return article.created_at or datetime.utcnow()

    def _get_date_and_readtime(self, article):
        created = self._get_article_date(article)
        date_label = created.strftime("%b %d, %Y")
        word_count = len(article.content or "") // 5
        read_time = max(3, word_count // 200)
        return date_label, read_time

    def _build_post_entry(self, article, new_id, image_paths, slug,
                          existing_posts: list = None) -> dict:
        """构建 A1/A2/D 类型的 post 条目，自动适配目标站点的字段格式"""
        category_name = self._get_category_name(article)
        date_label, read_time = self._get_date_and_readtime(article)
        created = self._get_article_date(article)

        tags = []
        if hasattr(article, "tags") and article.tags:
            for at in article.tags:
                if hasattr(at, "tag") and at.tag:
                    tags.append(at.tag.name)
        if not tags:
            tags = [category_name.lower()]

        hero = image_paths["hero"] or article.featured_image or ""

        # 检测已有文章的字段格式
        use_url_style = False
        if existing_posts:
            sample = existing_posts[0]
            use_url_style = "url" in sample and "detailUrl" not in sample

        if use_url_style:
            return {
                "id": new_id,
                "title": article.title,
                "category": category_name,
                "date": created.strftime("%Y-%m-%d"),
                "displayDate": date_label,
                "readingTime": f"{read_time} min read",
                "excerpt": article.excerpt or "",
                "url": f"post-{slug}.html",
                "image": hero,
                "tags": tags,
            }

        return {
            "id": new_id,
            "slug": slug,
            "title": article.title,
            "category": category_name,
            "dateISO": created.strftime("%Y-%m-%d"),
            "dateLabel": date_label,
            "readTime": f"{read_time} min read",
            "excerpt": article.excerpt or "",
            "heroImage": hero,
            "tags": tags,
            "primaryProduct": "",
            "detailUrl": f"post-{slug}.html",
        }

    # ─── 通用 JS 数组解析/重建 ───

    def _parse_js_array(self, js_content: str, var_name: str) -> list:
        """解析 JS 中的 const/let/var {var_name} = [...] 或 window.{var_name} = [...] 数组。
        
        支持 const posts, window.VERVE_POSTS, const articlesIndex 等。
        """
        # 先尝试 const/let/var 声明
        pattern = rf'(?:const|let|var)\s+{re.escape(var_name)}\s*=\s*\['
        match = re.search(pattern, js_content)
        if not match:
            # 再尝试 window.X = [ 赋值
            pattern2 = rf'window\.{re.escape(var_name)}\s*=\s*\['
            match = re.search(pattern2, js_content)
        if not match:
            raise ValueError(f"无法在 JS 中找到 {var_name} = [")

        start = match.end() - 1  # [ 的位置
        # 找到数组结束位置
        depth = 0
        i = start
        while i < len(js_content):
            ch = js_content[i]
            if ch == '[':
                depth += 1
            elif ch == ']':
                depth -= 1
                if depth == 0:
                    break
            elif ch in ('"', "'", '`'):
                quote = ch
                i += 1
                while i < len(js_content) and js_content[i] != quote:
                    if js_content[i] == '\\':
                        i += 1
                    i += 1
            i += 1

        array_str = js_content[start:i + 1]

        # 提取每个 { ... } 对象
        items = []
        obj_pattern = re.compile(r'\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}', re.DOTALL)
        for obj_match in obj_pattern.finditer(array_str):
            obj_str = obj_match.group(1)
            item = self._extract_post_fields(obj_str)
            if item.get("slug") or item.get("title") or item.get("id"):
                items.append(item)

        return items

    def _rebuild_js_array(self, original: str, var_name: str, items: list) -> str:
        """用新的数组重建 JS 文件，保留其余代码不变"""
        pattern = rf'(?:const|let|var)\s+{re.escape(var_name)}\s*=\s*\['
        match = re.search(pattern, original)
        if not match:
            pattern2 = rf'window\.{re.escape(var_name)}\s*=\s*\['
            match = re.search(pattern2, original)
        if not match:
            raise ValueError(f"无法在 JS 中找到 {var_name} = [")

        decl_start = match.start()
        bracket_start = match.end() - 1
        depth = 0
        i = bracket_start
        while i < len(original):
            ch = original[i]
            if ch == '[':
                depth += 1
            elif ch == ']':
                depth -= 1
                if depth == 0:
                    break
            elif ch in ('"', "'", '`'):
                quote = ch
                i += 1
                while i < len(original) and original[i] != quote:
                    if original[i] == '\\':
                        i += 1
                    i += 1
            i += 1
        end = i + 1

        # 跳过分号
        if end < len(original) and original[end] == ';':
            end += 1

        # 检测原始声明是否使用 window.X 格式，以及 const/let/var
        decl_text = original[decl_start:match.end()]
        use_window = decl_text.startswith("window.")
        decl_keyword = "const"
        if decl_text.startswith("var "):
            decl_keyword = "var"
        elif decl_text.startswith("let "):
            decl_keyword = "let"

        items_js = self._items_to_js(var_name, items, use_window=use_window, decl_keyword=decl_keyword)
        return original[:decl_start] + items_js + original[end:]

    def _items_to_js(self, var_name: str, items: list, use_window: bool = False, decl_keyword: str = "const") -> str:
        """将数组转为 JS 格式代码"""
        if use_window:
            decl = f"window.{var_name} = ["
        else:
            decl = f"{decl_keyword} {var_name} = ["
        lines = [decl]
        for item in items:
            lines.append("  {")
            for key, value in item.items():
                if isinstance(value, bool):
                    lines.append(f"    {key}: {'true' if value else 'false'},")
                elif isinstance(value, int):
                    lines.append(f"    {key}: {value},")
                elif isinstance(value, list):
                    lines.append(f"    {key}: {json.dumps(value, ensure_ascii=False)},")
                else:
                    lines.append(f"    {key}: '{self._js_escape(str(value))}',")
            lines.append("  },")
        lines.append("];")
        return "\n".join(lines)

    def _extract_post_fields(self, obj_str: str) -> dict:
        """从 JS 对象字符串中提取字段值"""
        post = {}

        # 提取数字字段
        id_m = re.search(r'\bid\s*:\s*(\d+)', obj_str)
        if id_m:
            post["id"] = int(id_m.group(1))

        # 提取字符串字段（支持单引号和双引号，兼容多种站点格式）
        str_fields = ["slug", "title", "category", "dateISO", "dateLabel",
                       "readTime", "heroImage", "primaryProduct", "detailUrl",
                       "date", "displayDate", "readingTime", "image", "url"]
        for field in str_fields:
            # 匹配 field: 'value' 或 field: "value"（支持多行 excerpt 等）
            m = re.search(
                rf'\b{field}\s*:\s*([\'"])((?:(?!\1)[^\\]|\\.)*?)\1',
                obj_str, re.DOTALL
            )
            if m:
                val = m.group(2)
                # 还原 JS 转义
                val = val.replace("\\'", "'").replace('\\"', '"').replace("\\n", "\n")
                post[field] = val

        # excerpt 可能跨多行，单独处理
        if "excerpt" not in post:
            m = re.search(
                r'\bexcerpt\s*:\s*([\'"`])((?:(?!\1)[^\\]|\\.)*?)\1',
                obj_str, re.DOTALL
            )
            if m:
                val = m.group(2).replace("\\'", "'").replace('\\"', '"').replace("\\n", "\n")
                post["excerpt"] = val
        else:
            # 已经提取到了
            pass

        # 也尝试从 str_fields 中提取 excerpt
        if "excerpt" not in post:
            # 尝试匹配多行 excerpt（可能用模板字符串）
            m = re.search(r'\bexcerpt\s*:\s*`(.*?)`', obj_str, re.DOTALL)
            if m:
                post["excerpt"] = m.group(1)

        # 提取 tags 数组
        tags_m = re.search(r'\btags\s*:\s*\[(.*?)\]', obj_str, re.DOTALL)
        if tags_m:
            tags_str = tags_m.group(1)
            post["tags"] = re.findall(r"['\"]([^'\"]+)['\"]", tags_str)
        else:
            post["tags"] = []

        return post

    def _js_escape(self, s: str) -> str:
        """转义 JS 单引号字符串中的特殊字符"""
        if not s:
            return ""
        return s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n").replace("\r", "")

    def _generate_article_html(self, article, category: str, date_label: str, read_time: int,
                               hero_path: str = None, content_image_paths: List[str] = None) -> str:
        """生成与 AuraBloom 原有文章完全一致的详情页 HTML"""
        title = self._html_escape(article.title)
        excerpt = self._html_escape(article.excerpt or "")
        hero_image = hero_path or article.featured_image or ""
        content_html = article.content or ""

        # 清洗 content：去除 JSON 转义残留、\n 字面文本
        content_html = content_html.replace("\\n", "\n").replace("\\t", "\t")
        content_html = content_html.replace('\\"', '"').replace("\\/", "/")
        content_html = re.sub(r'(?<!\\)\\n', '\n', content_html)
        # 去掉可能的 JSON 包裹残留
        content_html = re.sub(r'^\s*\{\s*"content"\s*:\s*"?', '', content_html)
        content_html = re.sub(r'"?\s*[,}]\s*"excerpt"[\s\S]*$', '', content_html)
        content_html = re.sub(r'"?\s*\}\s*$', '', content_html)
        content_html = content_html.strip()

        if content_image_paths:
            content_html = self._insert_content_images(content_html, content_image_paths)

        tags_list = []
        if hasattr(article, "tags") and article.tags:
            for at in article.tags:
                if hasattr(at, "tag") and at.tag:
                    tags_list.append(at.tag.name)

        meta_pills = f'<span class="ab-inline-pill">Category: {self._html_escape(category)}</span>'
        if tags_list:
            theme_str = " &middot; ".join(self._html_escape(t) for t in tags_list)
            meta_pills += f'\n              <span class="ab-inline-pill">Theme: {theme_str}</span>'

        kicker = f'{self._html_escape(category)} &middot; {date_label} &middot; {read_time} min read'

        aside_items = []
        if tags_list:
            for t in tags_list[:3]:
                aside_items.append(f"              <li>{self._html_escape(t)}</li>")
        aside_list = "\n".join(aside_items) if aside_items else ""
        aside_section = f"""
          <aside class="ab-aside-card">
            <h3>About this story</h3>
            <ul>
              <li>Category: {self._html_escape(category)}</li>
              <li>Reading time: approximately {read_time} minutes</li>
{aside_list}
            </ul>
            <p class="ab-aside-meta">
              Published on {date_label}. Discover more stories and gentle guides on <a href="index.html">AuraBloom</a>.
            </p>
          </aside>"""

        html = f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{title} &#8211; AuraBloom</title>
  <link rel="stylesheet" href="assets/css/style.css" />
  <link rel="preconnect" href="https://images.unsplash.com" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@300;400;600;700&display=swap" rel="stylesheet" />
</head>
<body class="ab-body">
  <div class="ab-page-wrapper">
    <header class="ab-header">
      <div class="ab-header-inner">
        <a href="index.html" class="ab-logo">
          <div class="ab-logo-mark">AB</div>
          <div class="ab-logo-text">
            <span class="ab-logo-title">AuraBloom</span>
            <span class="ab-logo-subtitle">Soft &amp; Warm Living</span>
          </div>
        </a>
        <button class="ab-nav-toggle" aria-label="Toggle navigation">
          <span></span><span></span><span></span>
        </button>
        <nav class="ab-nav">
          <a href="index.html">Home</a>
          <a href="index.html#categories">Categories</a>
          <a href="index.html#latest" class="is-active">Blog</a>
          <a href="products.html">Products</a>
          <a href="about.html">About</a>
          <a href="contact.html">Contact</a>
        </nav>
      </div>
    </header>

    <main class="ab-main">
      <article class="ab-page">
        <header class="ab-page-header">
          <p class="ab-page-kicker">{kicker}</p>
          <h1 class="ab-page-title">{title}</h1>
          <p class="ab-page-subtitle">
            {excerpt}
          </p>
        </header>

        <div class="ab-page-grid">
          <div class="ab-page-main">
            <div class="ab-page-hero-img">
              <img
                src="{hero_image}"
                alt="{title}"
                loading="lazy"
              />
            </div>
            <div class="ab-page-meta-row">
              {meta_pills}
            </div>

            {content_html}

          </div>
{aside_section}
        </div>
      </article>
    </main>

    <footer class="ab-footer">
      <div class="ab-footer-inner">
        <div class="ab-footer-brand">
          <div class="ab-logo ab-logo-footer">
            <div class="ab-logo-mark">AB</div>
            <div class="ab-logo-text">
              <span class="ab-logo-title">AuraBloom</span>
              <span class="ab-logo-subtitle">Soft &amp; Warm Living</span>
            </div>
          </div>
          <p class="ab-footer-copy">
            Soft stories, calm visuals and gentle routines for every corner of your life.
          </p>
        </div>

        <div class="ab-footer-links">
          <div>
            <h3>Explore</h3>
            <a href="index.html#latest">Latest stories</a>
            <a href="products.html">Product reviews</a>
            <a href="about.html">About AuraBloom</a>
            <a href="contact.html">Contact</a>
          </div>
          <div>
            <h3>Categories</h3>
            <a href="index.html#categories">Fashion &amp; Accessories</a>
            <a href="index.html#categories">Health &amp; Beauty</a>
            <a href="index.html#categories">Home &amp; Garden</a>
            <a href="index.html#categories">Travel &amp; Stays</a>
          </div>
        </div>

        <div class="ab-footer-social">
          <h3>Stay connected</h3>
          <div class="ab-social-widget">
            <a href="https://www.instagram.com/aurabloom" aria-label="AuraBloom on Instagram" class="ab-social-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="5"></rect>
                <circle cx="12" cy="12" r="4.2"></circle>
                <circle cx="17.3" cy="6.7" r="1.1"></circle>
              </svg>
            </a>
            <a href="https://www.pinterest.com/aurabloom" aria-label="AuraBloom on Pinterest" class="ab-social-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="9"></circle>
                <path d="M12 7.5c-2.5 0-4 1.7-4 3.7 0 1.5.9 2.7 2.5 2.7.4 0 .7-.2.8-.6l.3-1.2c.1-.3 0-.5-.2-.7-.4-.3-.6-.8-.6-1.3 0-1 .7-1.8 1.8-1.8 1 0 1.6.7 1.6 1.7 0 1.3-.6 2.3-1.5 2.3-.3 0-.6-.1-.7-.3l-.3 1.1-.2.8c-.1.3-.2.7-.2 1l1 .3c.3-1 .7-2.1.7-2.4.1-.2.1-.3.2-.5.2.3.7.5 1.1.5 1.4 0 2.6-1.4 2.6-3.4 0-2-1.5-3.7-3.9-3.7z" fill="#f8f5f2"></path>
              </svg>
            </a>
            <a href="https://www.tiktok.com/@aurabloom" aria-label="AuraBloom on TikTok" class="ab-social-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M15.5 5.1c.5.7 1.1 1.3 1.8 1.7.6.4 1.3.6 2 .7v2.5c-.8 0-1.6-.2-2.4-.5-.6-.3-1.2-.6-1.7-1.1v6.3c0 2.7-2.2 4.8-4.8 4.8S5.5 17.4 5.5 14.8 7.7 10 10.3 10c.4 0 .7 0 1 .1v2.6c-.3-.1-.6-.1-.9-.1-1.2 0-2.2 1-2.2 2.3s1 2.3 2.3 2.3 2.3-1 2.3-2.3V4.5h2.7v.6z"></path>
              </svg>
            </a>
            <a href="https://www.youtube.com/@aurabloom" aria-label="AuraBloom on YouTube" class="ab-social-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="7" width="18" height="10" rx="3"></rect>
                <path d="M11 10v4l3.5-2z" fill="#f8f5f2"></path>
              </svg>
            </a>
          </div>
          <p class="ab-footer-meta">&copy; 2025 AuraBloom. All rights reserved.</p>
        </div>
      </div>
    </footer>
  </div>

  <script src="assets/js/main.js"></script>
</body>
</html>'''
        return html

    def _html_escape(self, s: str) -> str:
        """HTML 转义"""
        if not s:
            return ""
        return (
            s.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
            .replace("'", "&#39;")
        )


# 单例
remote_publisher = RemotePublisher()
