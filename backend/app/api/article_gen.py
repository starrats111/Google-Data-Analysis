"""
AI 生成 API（OPT-011）
"""
import logging
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.services.article_gen_service import ArticleGenService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/article-gen", tags=["AI生成"])


class TitleGenRequest(BaseModel):
    prompt: str
    count: int = 10


class ArticleGenRequest(BaseModel):
    title: str
    keywords: Optional[List[str]] = None
    links: Optional[List[dict]] = None
    style: str = "informative"


class ImageGenRequest(BaseModel):
    title: str
    count: int = 5


@router.post("/titles")
async def generate_titles(
    data: TitleGenRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        service = ArticleGenService()
        titles = service.generate_titles(data.prompt, data.count)
        return {"titles": titles}
    except Exception as e:
        logger.error(f"标题生成失败: {e}")
        raise HTTPException(status_code=500, detail=f"标题生成失败: {str(e)}")


@router.post("/article")
async def generate_article(
    data: ArticleGenRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        service = ArticleGenService()
        result = service.generate_article(
            title=data.title,
            keywords=data.keywords,
            links=data.links,
            style=data.style,
        )
        return result
    except Exception as e:
        logger.error(f"文章生成失败: {e}")
        raise HTTPException(status_code=500, detail=f"文章生成失败: {str(e)}")


@router.post("/images")
async def generate_images(
    data: ImageGenRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        service = ArticleGenService()
        images = service.generate_images(data.title, data.count)
        return {"images": images}
    except Exception as e:
        logger.error(f"配图生成失败: {e}")
        raise HTTPException(status_code=500, detail=f"配图生成失败: {str(e)}")
