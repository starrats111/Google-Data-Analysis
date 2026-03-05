"""
Slug 生成工具（OPT-011）
"""
import re
import unicodedata
from datetime import datetime


def generate_slug(title: str, max_length: int = 180) -> str:
    """将标题转换为 URL-safe slug，支持中英文混合"""
    slug = unicodedata.normalize("NFKD", title)
    slug = slug.lower().strip()
    slug = re.sub(r"[^\w\s\u4e00-\u9fff-]", "", slug)
    slug = re.sub(r"[\s_]+", "-", slug)
    slug = re.sub(r"-+", "-", slug)
    slug = slug.strip("-")

    if len(slug) > max_length:
        slug = slug[:max_length].rstrip("-")

    if not slug:
        slug = f"article-{datetime.now().strftime('%Y%m%d%H%M%S')}"

    return slug
