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

    # ─── CR-037: 网站架构自动检测 ───

    def _remote_file_exists(self, sftp: paramiko.SFTPClient, path: str) -> bool:
        """检查远程文件是否存在"""
        try:
            sftp.stat(path)
            return True
        except FileNotFoundError:
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

        # B1: js/articles-index.js + articlesIndex
        p = f"{site_root}/js/articles-index.js"
        if self._remote_file_exists(sftp, p) and self._remote_file_contains(sftp, p, "articlesIndex"):
            return {
                "site_type": SITE_TYPE_ARTICLES_INDEX,
                "data_js_path": "js/articles-index.js",
                "article_var_name": "articlesIndex",
                "article_html_pattern": "article-{slug}.html",
            }

        # B2: js/main.js + const articles / const articlesData (内嵌)
        p = f"{site_root}/js/main.js"
        if self._remote_file_exists(sftp, p):
            content = ""
            try:
                content = self._sftp_read(sftp, p)
            except Exception:
                pass
            if "const articles " in content or "const articles=" in content:
                return {
                    "site_type": SITE_TYPE_ARTICLES_INLINE,
                    "data_js_path": "js/main.js",
                    "article_var_name": "articles",
                    "article_html_pattern": "article-{slug}.html",
                }
            if "const articlesData " in content or "const articlesData=" in content:
                return {
                    "site_type": SITE_TYPE_ARTICLES_INLINE,
                    "data_js_path": "js/main.js",
                    "article_var_name": "articlesData",
                    "article_html_pattern": "article-{slug}.html",
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

    def _download_image(self, url: str) -> Optional[bytes]:
        """从外部 URL 下载图片，返回二进制数据"""
        if not url:
            return None
        try:
            resp = requests.get(url, timeout=15, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                "Referer": url,
                "Accept": "image/*,*/*;q=0.8",
            })
            resp.raise_for_status()
            if len(resp.content) < 100:
                logger.warning(f"图片太小，可能无效: {url}")
                return None
            return resp.content
        except Exception as e:
            logger.warning(f"图片下载失败: {url} -> {e}")
            return None

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
            data = self._download_image(featured_image)
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
                result["content"].append(img_url)

        return result

    def _insert_content_images(self, content_html: str, image_paths: List[str]) -> str:
        """将内容图片分散插入到文章各章节（<h2>）之间"""
        if not image_paths:
            return content_html

        h2_positions = [m.start() for m in re.finditer(r'<h2[^>]*>', content_html)]

        if len(h2_positions) <= 1:
            img_block = "\n".join(
                f'            <div class="ab-page-hero-img">\n'
                f'              <img src="{p}" alt="Article image" loading="lazy" />\n'
                f'            </div>'
                for p in image_paths
            )
            return content_html + "\n" + img_block

        insert_points = []
        if len(h2_positions) >= 2:
            step = max(1, len(h2_positions) // (len(image_paths) + 1))
            for i in range(len(image_paths)):
                idx = min((i + 1) * step, len(h2_positions) - 1)
                insert_points.append(h2_positions[idx])

        result_parts = []
        last_pos = 0
        img_idx = 0
        for pos in sorted(set(insert_points)):
            if img_idx >= len(image_paths):
                break
            result_parts.append(content_html[last_pos:pos])
            img_tag = (
                f'\n            <div class="ab-page-hero-img">\n'
                f'              <img\n'
                f'                src="{image_paths[img_idx]}"\n'
                f'                alt="Article illustration"\n'
                f'                loading="lazy"\n'
                f'              />\n'
                f'            </div>\n\n'
            )
            result_parts.append(img_tag)
            last_pos = pos
            img_idx += 1

        result_parts.append(content_html[last_pos:])
        return "".join(result_parts)

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

            # 如果 site_type 为空，先自动检测
            if not site_type:
                detected = self._detect_site_type_inner(sftp, site_root)
                site_type = detected.get("site_type")
                logger.info(f"[发布] 自动检测 {site.domain} 架构: {site_type}")
                if not site_type:
                    raise ValueError(f"无法识别网站 {site.domain} 的文章架构，请检查网站目录结构")

            # 处理图片（所有类型通用）
            content_image_urls = []
            if hasattr(article, "images") and article.images:
                sorted_imgs = sorted(article.images, key=lambda x: (x.position or 0))
                content_image_urls = [img.url for img in sorted_imgs if img.url]

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

            sftp.close()
            logger.info(f"文章已远程发布: slug={slug}, site={site.site_name}, type={site_type}, "
                        f"images: hero={'yes' if image_paths['hero'] else 'no'}, "
                        f"content={len(image_paths['content'])}")
            return result
        finally:
            ssh.close()

    # ─── 各架构类型的发布实现 ───

    def _publish_posts_type(self, ssh, sftp, site, article, image_paths, site_type) -> dict:
        """A1/A2/D 类型: 操作 const posts / const POSTS 数组"""
        site_root = site.site_path
        slug = article.slug

        # 确定数据文件路径和变量名
        if site_type == SITE_TYPE_POSTS_ASSETS_JS:
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

        if any(p.get("slug") == slug for p in posts):
            raise ValueError(f"slug '{slug}' 已存在于网站 {var_name} 中")

        new_id = max((p.get("id", 0) for p in posts), default=0) + 1
        new_post = self._build_post_entry(article, new_id, image_paths, slug)

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
        """B1 类型: 操作 articlesIndex 数组 + 生成 articles/{slug}.json"""
        site_root = site.site_path
        slug = article.slug
        data_path = f"{site_root}/{site.data_js_path or 'js/articles-index.js'}"

        content = self._sftp_read(sftp, data_path)
        articles_list = self._parse_js_array(content, "articlesIndex")

        # 检查重复
        if any(a.get("slug") == slug or str(a.get("id")) == slug for a in articles_list):
            raise ValueError(f"slug '{slug}' 已存在于 articlesIndex 中")

        new_id = max((a.get("id", 0) for a in articles_list if isinstance(a.get("id"), int)), default=0) + 1
        category_name = self._get_category_name(article)
        date_label, read_time = self._get_date_and_readtime(article)
        created = article.created_at or datetime.utcnow()

        # 索引条目
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

        # 生成 articles/{slug}.json 详情文件
        articles_dir = f"{site_root}/articles"
        self._ensure_dir(ssh, articles_dir)

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
        json_path = f"{articles_dir}/{slug}.json"
        self._sftp_write(sftp, json_path, json.dumps(detail_json, ensure_ascii=False, indent=2))

        logger.info(f"[B1] 已写入 articlesIndex + articles/{slug}.json")
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
        created = article.created_at or datetime.utcnow()

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
        created = article.created_at or datetime.utcnow()

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
        """A1/A2/D: 从 posts/POSTS 数组移除 + 删除 HTML"""
        site_root = site.site_path
        if site_type == SITE_TYPE_POSTS_ASSETS_JS:
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
        """B1: 从 articlesIndex 移除 + 删除 articles/{slug}.json"""
        site_root = site.site_path
        data_path = f"{site_root}/{site.data_js_path or 'js/articles-index.js'}"

        content = self._sftp_read(sftp, data_path)
        arr = self._parse_js_array(content, "articlesIndex")
        arr = [a for a in arr if a.get("slug") != slug and str(a.get("id")) != slug]
        new_content = self._rebuild_js_array(content, "articlesIndex", arr)
        self._sftp_write(sftp, data_path, new_content)

        try:
            sftp.remove(f"{site_root}/articles/{slug}.json")
        except FileNotFoundError:
            logger.warning(f"文章 JSON 不存在: articles/{slug}.json")

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

    def _get_date_and_readtime(self, article):
        created = article.created_at or datetime.utcnow()
        date_label = created.strftime("%b %d, %Y")
        word_count = len(article.content or "") // 5
        read_time = max(3, word_count // 200)
        return date_label, read_time

    def _build_post_entry(self, article, new_id, image_paths, slug) -> dict:
        """构建 A1/A2/D 类型的 post 条目"""
        category_name = self._get_category_name(article)
        date_label, read_time = self._get_date_and_readtime(article)
        created = article.created_at or datetime.utcnow()

        tags = []
        if hasattr(article, "tags") and article.tags:
            for at in article.tags:
                if hasattr(at, "tag") and at.tag:
                    tags.append(at.tag.name)
        if not tags:
            tags = [category_name.lower()]

        return {
            "id": new_id,
            "slug": slug,
            "title": article.title,
            "category": category_name,
            "dateISO": created.strftime("%Y-%m-%d"),
            "dateLabel": date_label,
            "readTime": f"{read_time} min read",
            "excerpt": article.excerpt or "",
            "heroImage": image_paths["hero"] or article.featured_image or "",
            "tags": tags,
            "primaryProduct": "",
            "detailUrl": f"post-{slug}.html",
        }

    # ─── 通用 JS 数组解析/重建 ───

    def _parse_js_array(self, js_content: str, var_name: str) -> list:
        """解析 JS 中的 const/let/var {var_name} = [...] 数组。
        
        支持 const posts, const POSTS, const articlesIndex, const articles,
        const articlesData, const blogPosts 等。
        """
        # 匹配 const/let/var varName = [
        pattern = rf'(?:const|let|var)\s+{re.escape(var_name)}\s*=\s*\['
        match = re.search(pattern, js_content)
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

        # 生成新的 JS 代码
        items_js = self._items_to_js(var_name, items)
        return original[:decl_start] + items_js + original[end:]

    def _items_to_js(self, var_name: str, items: list) -> str:
        """将数组转为 JS 格式代码"""
        lines = [f"const {var_name} = ["]
        for item in items:
            lines.append("  {")
            for key, value in item.items():
                if isinstance(value, int):
                    lines.append(f"    {key}: {value},")
                elif isinstance(value, bool):
                    lines.append(f"    {key}: {'true' if value else 'false'},")
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

        # 提取字符串字段（支持单引号和双引号）
        str_fields = ["slug", "title", "category", "dateISO", "dateLabel",
                       "readTime", "heroImage", "primaryProduct", "detailUrl"]
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
