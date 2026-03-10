"""
Slug 生成工具（OPT-011）
"""
import re
import unicodedata
from datetime import datetime


def generate_slug(title: str, max_length: int = 180) -> str:
    """将标题转换为 URL-safe slug，支持中英文混合。

    与远程网站 JS ``titleToSlug`` 行为保持一致：
    只保留 ASCII 字母数字、中文字符、空格和连字符。
    """
    slug = title.lower().strip()
    slug = re.sub(r"[^a-z0-9\s\u4e00-\u9fff-]", "", slug)
    slug = re.sub(r"[\s]+", "-", slug)
    slug = re.sub(r"-+", "-", slug)
    slug = slug.strip("-")

    if len(slug) > max_length:
        slug = slug[:max_length].rstrip("-")

    if not slug:
        slug = f"article-{datetime.now().strftime('%Y%m%d%H%M%S')}"

    return slug
