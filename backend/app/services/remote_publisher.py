"""
远程网站发布服务（CR-035）
通过 SSH 连接宝塔服务器，远程写入/删除文章文件。
适配 AuraBloom 的 main.js posts 数组格式。
"""
import json
import logging
import re
from datetime import datetime
from io import StringIO
from typing import Optional

import paramiko

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
        """确保远程目录存在"""
        ssh.exec_command(f"mkdir -p {path}")

    def publish_article(self, site, article) -> dict:
        """
        发布文章到宝塔服务器：
        1. 读取远程 main.js
        2. 解析 const posts = [...]
        3. 追加新文章条目
        4. 写回 main.js
        5. 上传文章详情页 HTML
        """
        site_root = site.site_path  # e.g. /www/wwwroot/aura-bloom.top
        main_js_path = f"{site_root}/assets/js/main.js"
        slug = article.slug

        ssh = self._connect()
        try:
            sftp = ssh.open_sftp()

            # 1. 读取 main.js
            main_js_content = self._sftp_read(sftp, main_js_path)

            # 2. 解析 posts 数组
            posts = self._parse_posts(main_js_content)

            # 3. 检查 slug 是否已存在
            if any(p.get("slug") == slug for p in posts):
                raise ValueError(f"slug '{slug}' 已存在于网站 posts 中")

            # 4. 构建新 post 条目
            new_id = max((p.get("id", 0) for p in posts), default=0) + 1
            category_name = "General"
            if article.category and hasattr(article.category, "name"):
                category_name = article.category.name

            # 计算阅读时间
            word_count = len(article.content or "") // 5  # 粗略估算
            read_time = max(3, word_count // 200)

            # 日期
            created = article.created_at or datetime.utcnow()
            date_iso = created.strftime("%Y-%m-%d")
            date_label = created.strftime("%b %d, %Y")

            # 标签
            tags = []
            if hasattr(article, "tags") and article.tags:
                for at in article.tags:
                    if hasattr(at, "tag") and at.tag:
                        tags.append(at.tag.name)
            if not tags:
                tags = [category_name.lower()]

            detail_url = f"post-{slug}.html"

            new_post = {
                "id": new_id,
                "slug": slug,
                "title": article.title,
                "category": category_name,
                "dateISO": date_iso,
                "dateLabel": date_label,
                "readTime": f"{read_time} min read",
                "excerpt": article.excerpt or "",
                "heroImage": article.featured_image or "",
                "tags": tags,
                "primaryProduct": "",
                "detailUrl": detail_url,
            }

            # 5. 追加到 posts 数组并写回
            posts.insert(0, new_post)  # 新文章放最前面
            new_main_js = self._rebuild_main_js(main_js_content, posts)
            self._sftp_write(sftp, main_js_path, new_main_js)

            # 6. 生成并上传文章详情页 HTML
            html_content = self._generate_article_html(article, category_name, date_label, read_time)
            html_path = f"{site_root}/{detail_url}"
            self._sftp_write(sftp, html_path, html_content)

            sftp.close()
            logger.info(f"文章已远程发布: slug={slug}, site={site.site_name}")
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
        """解析 main.js 中的 const posts = [...] 数组"""
        # 匹配 const posts = [ ... ]; 支持多行
        pattern = r'const\s+posts\s*=\s*\['
        match = re.search(pattern, main_js)
        if not match:
            raise ValueError("无法在 main.js 中找到 const posts = [")

        start = match.end() - 1  # 回到 [ 位置
        # 手动匹配括号找到结束位置
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
                # 跳过字符串
                quote = ch
                i += 1
                while i < len(main_js) and main_js[i] != quote:
                    if main_js[i] == '\\':
                        i += 1
                    i += 1
            i += 1

        array_str = main_js[start:i + 1]

        # JS 对象转 JSON：给无引号的 key 加引号，处理尾逗号
        json_str = self._js_array_to_json(array_str)
        try:
            return json.loads(json_str)
        except json.JSONDecodeError as e:
            logger.error(f"解析 posts 数组失败: {e}")
            raise ValueError(f"解析 posts 数组失败: {e}")

    def _js_array_to_json(self, js_str: str) -> str:
        """将 JS 对象数组转为合法 JSON"""
        # 移除单行注释
        result = re.sub(r'//.*?$', '', js_str, flags=re.MULTILINE)
        # 移除多行注释
        result = re.sub(r'/\*.*?\*/', '', result, flags=re.DOTALL)
        # 给无引号的 key 加双引号: word: -> "word":
        result = re.sub(r'(?<=[{,\n])\s*(\w+)\s*:', r' "\1":', result)
        # 单引号转双引号（但保留字符串内的转义单引号）
        result = self._single_to_double_quotes(result)
        # 移除尾逗号
        result = re.sub(r',\s*([}\]])', r'\1', result)
        return result

    def _single_to_double_quotes(self, s: str) -> str:
        """将 JS 单引号字符串转为双引号"""
        result = []
        i = 0
        while i < len(s):
            if s[i] == '"':
                # 已经是双引号字符串，跳过
                result.append('"')
                i += 1
                while i < len(s) and s[i] != '"':
                    if s[i] == '\\':
                        result.append(s[i])
                        i += 1
                        if i < len(s):
                            result.append(s[i])
                            i += 1
                    else:
                        result.append(s[i])
                        i += 1
                if i < len(s):
                    result.append('"')
                    i += 1
            elif s[i] == "'":
                # 单引号字符串转双引号
                result.append('"')
                i += 1
                while i < len(s) and s[i] != "'":
                    if s[i] == '\\':
                        result.append(s[i])
                        i += 1
                        if i < len(s):
                            # 如果是转义的单引号，改为普通单引号
                            if s[i] == "'":
                                result.append("'")
                            else:
                                result.append(s[i])
                            i += 1
                    elif s[i] == '"':
                        # 双引号在单引号字符串内需要转义
                        result.append('\\"')
                        i += 1
                    else:
                        result.append(s[i])
                        i += 1
                if i < len(s):
                    result.append('"')
                    i += 1
            else:
                result.append(s[i])
                i += 1
        return ''.join(result)

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

    def _generate_article_html(self, article, category: str, date_label: str, read_time: int) -> str:
        """生成 AuraBloom 风格的文章详情页 HTML"""
        title = self._html_escape(article.title)
        excerpt = self._html_escape(article.excerpt or "")
        hero_image = article.featured_image or ""
        content_html = article.content or ""

        # 标签
        tags_html = ""
        if hasattr(article, "tags") and article.tags:
            for at in article.tags:
                if hasattr(at, "tag") and at.tag:
                    tags_html += f'<span class="ab-inline-pill">{self._html_escape(at.tag.name)}</span>\n'

        html = f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{title} – AuraBloom</title>
  <link rel="stylesheet" href="assets/css/style.css" />
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
          <p class="ab-page-kicker">{self._html_escape(category)} · {date_label} · {read_time} min read</p>
          <h1 class="ab-page-title">{title}</h1>
          <p class="ab-page-subtitle">{excerpt}</p>
        </header>

        <div class="ab-page-grid">
          <div class="ab-page-main">
            <div class="ab-page-hero-img">
              <img src="{hero_image}" alt="{title}" loading="lazy" />
            </div>
            <div class="ab-page-meta-row">
              <span class="ab-inline-pill">Category: {self._html_escape(category)}</span>
              {tags_html}
            </div>

            {content_html}
          </div>
        </div>
      </article>
    </main>

    <footer class="ab-footer">
      <div class="ab-footer-inner">
        <div class="ab-footer-brand">
          <div class="ab-logo">
            <div class="ab-logo-mark">AB</div>
            <div class="ab-logo-text">
              <span class="ab-logo-title">AuraBloom</span>
              <span class="ab-logo-subtitle">Soft &amp; Warm Living</span>
            </div>
          </div>
          <p>Soft stories, calm visuals and gentle routines for every corner of your life.</p>
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
