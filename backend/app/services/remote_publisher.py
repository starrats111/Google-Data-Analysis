"""
远程网站发布服务（CR-035）
通过 SSH 连接宝塔服务器，远程写入/删除文章文件。
适配 AuraBloom 的 main.js posts 数组格式。
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
        发布文章到宝塔服务器：
        1. 下载并上传图片到远程服务器
        2. 读取远程 main.js
        3. 解析 const posts = [...]
        4. 追加新文章条目
        5. 写回 main.js
        6. 生成并上传文章详情页 HTML（含嵌入图片）
        """
        site_root = site.site_path
        main_js_path = f"{site_root}/assets/js/main.js"
        slug = article.slug

        ssh = self._connect()
        try:
            sftp = ssh.open_sftp()

            content_image_urls = []
            if hasattr(article, "images") and article.images:
                sorted_imgs = sorted(article.images, key=lambda x: (x.position or 0))
                content_image_urls = [img.url for img in sorted_imgs if img.url]

            image_paths = self._process_images(
                ssh, sftp, site_root, slug,
                article.featured_image or "",
                content_image_urls,
            )

            main_js_content = self._sftp_read(sftp, main_js_path)
            posts = self._parse_posts(main_js_content)

            if any(p.get("slug") == slug for p in posts):
                raise ValueError(f"slug '{slug}' 已存在于网站 posts 中")

            new_id = max((p.get("id", 0) for p in posts), default=0) + 1
            category_name = "General"
            if article.category and hasattr(article.category, "name"):
                category_name = article.category.name

            word_count = len(article.content or "") // 5
            read_time = max(3, word_count // 200)

            created = article.created_at or datetime.utcnow()
            date_iso = created.strftime("%Y-%m-%d")
            date_label = created.strftime("%b %d, %Y")

            tags = []
            if hasattr(article, "tags") and article.tags:
                for at in article.tags:
                    if hasattr(at, "tag") and at.tag:
                        tags.append(at.tag.name)
            if not tags:
                tags = [category_name.lower()]

            detail_url = f"post-{slug}.html"
            hero_for_index = image_paths["hero"] or article.featured_image or ""

            new_post = {
                "id": new_id,
                "slug": slug,
                "title": article.title,
                "category": category_name,
                "dateISO": date_iso,
                "dateLabel": date_label,
                "readTime": f"{read_time} min read",
                "excerpt": article.excerpt or "",
                "heroImage": hero_for_index,
                "tags": tags,
                "primaryProduct": "",
                "detailUrl": detail_url,
            }

            posts.insert(0, new_post)
            new_main_js = self._rebuild_main_js(main_js_content, posts)
            self._sftp_write(sftp, main_js_path, new_main_js)

            html_content = self._generate_article_html(
                article, category_name, date_label, read_time,
                hero_path=image_paths["hero"],
                content_image_paths=image_paths["content"],
            )
            html_path = f"{site_root}/{detail_url}"
            self._sftp_write(sftp, html_path, html_content)

            sftp.close()
            logger.info(f"文章已远程发布: slug={slug}, site={site.site_name}, "
                        f"images: hero={'yes' if image_paths['hero'] else 'no'}, "
                        f"content={len(image_paths['content'])}")
            return {"site_article_slug": slug, "site_article_id": new_id}
        finally:
            ssh.close()

    def unpublish_article(self, site, slug: str):
        """
        从宝塔服务器移除文章：
        1. 读取 main.js，移除对应 post
        2. 写回 main.js
        3. 删除文章 HTML 文件
        """
        site_root = site.site_path
        main_js_path = f"{site_root}/assets/js/main.js"

        ssh = self._connect()
        try:
            sftp = ssh.open_sftp()

            # 1. 读取并移除
            main_js_content = self._sftp_read(sftp, main_js_path)
            posts = self._parse_posts(main_js_content)
            posts = [p for p in posts if p.get("slug") != slug]

            # 2. 写回
            new_main_js = self._rebuild_main_js(main_js_content, posts)
            self._sftp_write(sftp, main_js_path, new_main_js)

            # 3. 删除 HTML
            html_path = f"{site_root}/post-{slug}.html"
            try:
                sftp.remove(html_path)
            except FileNotFoundError:
                logger.warning(f"文章 HTML 不存在: {html_path}")

            sftp.close()
            logger.info(f"文章已远程移除: slug={slug}, site={site.site_name}")
        finally:
            ssh.close()

    def verify_connection(self, site_path: str) -> dict:
        """验证 SSH 连接和网站目录"""
        try:
            ssh = self._connect()
            sftp = ssh.open_sftp()
            checks = {
                "ssh_connected": True,
                "site_dir_exists": False,
                "main_js_exists": False,
                "index_html_exists": False,
            }
            try:
                sftp.stat(site_path)
                checks["site_dir_exists"] = True
            except FileNotFoundError:
                pass
            try:
                sftp.stat(f"{site_path}/assets/js/main.js")
                checks["main_js_exists"] = True
            except FileNotFoundError:
                pass
            try:
                sftp.stat(f"{site_path}/index.html")
                checks["index_html_exists"] = True
            except FileNotFoundError:
                pass
            checks["valid"] = all(checks.values())
            sftp.close()
            ssh.close()
            return checks
        except Exception as e:
            return {
                "ssh_connected": False,
                "error": str(e),
                "valid": False,
            }

    # ─── 内部方法 ───

    def _parse_posts(self, main_js: str) -> list:
        """解析 main.js 中的 const posts = [...] 数组
        
        使用正则逐字段提取，避免 JS->JSON 转换的兼容性问题。
        """
        pattern = r'const\s+posts\s*=\s*\['
        match = re.search(pattern, main_js)
        if not match:
            raise ValueError("无法在 main.js 中找到 const posts = [")

        start = match.end() - 1
        # 找到数组结束位置
        depth = 0
        i = start
        while i < len(main_js):
            ch = main_js[i]
            if ch == '[':
                depth += 1
            elif ch == ']':
                depth -= 1
                if depth == 0:
                    break
            elif ch in ('"', "'", '`'):
                quote = ch
                i += 1
                while i < len(main_js) and main_js[i] != quote:
                    if main_js[i] == '\\':
                        i += 1
                    i += 1
            i += 1

        array_str = main_js[start:i + 1]

        # 提取每个 { ... } 对象
        posts = []
        obj_pattern = re.compile(r'\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}', re.DOTALL)
        for obj_match in obj_pattern.finditer(array_str):
            obj_str = obj_match.group(1)
            post = self._extract_post_fields(obj_str)
            if post.get("slug") or post.get("title"):
                posts.append(post)

        return posts

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

    def _rebuild_main_js(self, original: str, posts: list) -> str:
        """用新的 posts 数组重建 main.js，保留其余代码不变"""
        # 找到原始 posts 数组的位置
        pattern = r'const\s+posts\s*=\s*\['
        match = re.search(pattern, original)
        if not match:
            raise ValueError("无法在 main.js 中找到 const posts = [")

        start = match.start()
        # 找到数组结束位置
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
        end = i + 1  # ] 后面的位置

        # 跳过分号
        if end < len(original) and original[end] == ';':
            end += 1

        # 生成新的 posts JS 代码
        posts_js = self._posts_to_js(posts)
        new_content = original[:start] + posts_js + original[end:]
        return new_content

    def _posts_to_js(self, posts: list) -> str:
        """将 posts 列表转为 JS 格式代码"""
        lines = ["const posts = ["]
        for p in posts:
            lines.append("  {")
            lines.append(f"    id: {p['id']},")
            lines.append(f"    slug: '{self._js_escape(p.get('slug', ''))}',")
            lines.append(f"    title: '{self._js_escape(p.get('title', ''))}',")
            lines.append(f"    category: '{self._js_escape(p.get('category', ''))}',")
            lines.append(f"    dateISO: '{p.get('dateISO', '')}',")
            lines.append(f"    dateLabel: '{self._js_escape(p.get('dateLabel', ''))}',")
            lines.append(f"    readTime: '{self._js_escape(p.get('readTime', ''))}',")
            # excerpt 可能很长，用模板字符串
            lines.append(f"    excerpt: '{self._js_escape(p.get('excerpt', ''))}',")
            lines.append(f"    heroImage: '{self._js_escape(p.get('heroImage', ''))}',")
            tags_str = json.dumps(p.get("tags", []), ensure_ascii=False)
            lines.append(f"    tags: {tags_str},")
            lines.append(f"    primaryProduct: '{self._js_escape(p.get('primaryProduct', ''))}',")
            lines.append(f"    detailUrl: '{self._js_escape(p.get('detailUrl', ''))}',")
            lines.append("  },")
        lines.append("];")
        return "\n".join(lines)

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
