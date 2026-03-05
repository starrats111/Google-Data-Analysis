"""
自动标签匹配服务（OPT-011）
根据文章内容自动匹配已有标签
"""
import logging
from typing import List, Dict

from sqlalchemy.orm import Session
from app.models.article import PubTag, PubArticleTag

logger = logging.getLogger(__name__)


class AutoTagsService:
    @staticmethod
    def match_tags(db: Session, article_id: int, content: str, title: str) -> List[Dict]:
        """根据文章标题和内容，自动匹配已有标签"""
        if not content and not title:
            return []

        text = f"{title} {content}".lower()
        all_tags = db.query(PubTag).all()
        matched = []

        for tag in all_tags:
            tag_name_lower = tag.name.lower()
            if tag_name_lower in text:
                count = text.count(tag_name_lower)
                confidence = min(1.0, count * 0.2)

                existing = db.query(PubArticleTag).filter(
                    PubArticleTag.article_id == article_id,
                    PubArticleTag.tag_id == tag.id,
                ).first()

                if not existing:
                    db.add(PubArticleTag(
                        article_id=article_id,
                        tag_id=tag.id,
                        auto_matched=True,
                        confidence=confidence,
                    ))
                    matched.append({
                        "tag_id": tag.id,
                        "tag_name": tag.name,
                        "confidence": confidence,
                    })

        if matched:
            db.commit()
            logger.info(f"[AutoTags] 文章 {article_id} 自动匹配 {len(matched)} 个标签")

        return matched
