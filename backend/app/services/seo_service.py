"""
SEO Meta 生成服务（OPT-011）
"""
import re
import logging
from typing import Dict, Optional

logger = logging.getLogger(__name__)


class SeoService:
    @staticmethod
    def generate_meta(title: str, content: str, excerpt: Optional[str] = None) -> Dict:
        """根据文章标题和内容生成 SEO meta 标签"""
        meta_title = title[:60] if title else ""

        if excerpt:
            meta_description = excerpt[:160]
        elif content:
            clean_text = re.sub(r"<[^>]+>", "", content)
            clean_text = re.sub(r"\s+", " ", clean_text).strip()
            meta_description = clean_text[:160]
        else:
            meta_description = meta_title

        words = re.findall(r"[\u4e00-\u9fff]+|[a-zA-Z]+", title or "")
        meta_keywords = ", ".join(words[:10])

        return {
            "meta_title": meta_title,
            "meta_description": meta_description,
            "meta_keywords": meta_keywords,
        }
