"""
露出审核管理 API
"""
import json
import logging
from typing import List
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import desc

from app.database import get_db
from app.models.user import User
from app.models.luchu import (
    LuchuArticle, LuchuReview, LuchuArticleVersion,
    LuchuNotification, LuchuOperationLog
)
from app.schemas.luchu import ReviewRequest, ReviewResponse, LuchuArticleListResponse
from app.middleware.auth import get_current_user, get_luchu_authorized_user, get_luchu_reviewer

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/luchu/reviews", tags=["luchu-reviews"])


@router.get("", response_model=List[LuchuArticleListResponse])
async def list_pending_reviews(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    current_user: User = Depends(get_luchu_reviewer),
    db: Session = Depends(get_db)
):
    """获取待审核列表（仅审核员/经理可见）"""
    
    query = db.query(LuchuArticle).filter(LuchuArticle.status == "pending")
    query = query.order_by(desc(LuchuArticle.created_at))
    
    total = query.count()
    articles = query.offset((page - 1) * page_size).limit(page_size).all()
    
    from app.models.luchu import LuchuWebsite
    
    result = []
    for article in articles:
        website = db.query(LuchuWebsite).filter(LuchuWebsite.id == article.website_id).first()
        author = db.query(User).filter(User.id == article.author_id).first()
        
        result.append(LuchuArticleListResponse(
            id=article.id,
            title=article.title,
            status=article.status,
            website_id=article.website_id,
            website_name=website.name if website else None,
            author_id=article.author_id,
            author_name=author.display_name or author.username if author else None,
            publish_date=article.publish_date,
            created_at=article.created_at
        ))
    
    return result


@router.post("/{article_id}/approve", response_model=ReviewResponse)
async def approve_article(
    article_id: int,
    data: ReviewRequest = None,
    current_user: User = Depends(get_luchu_reviewer),
    db: Session = Depends(get_db)
):
    """审核通过"""
    
    article = db.query(LuchuArticle).filter(LuchuArticle.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="文章不存在")
    
    if article.status != "pending":
        raise HTTPException(status_code=400, detail="文章状态不是待审核")
    
    # 更新状态
    article.status = "ready"  # 待发布
    article.updated_at = datetime.utcnow()
    
    review = LuchuReview(
        article_id=article_id,
        reviewer_id=current_user.id,
        status="approved",
        review_type="peer",
        comment=data.comment if data else None
    )
    db.add(review)
    
    notification = LuchuNotification(
        user_id=article.author_id,
        type="review_approved",
        title="文章审核通过",
        content=f"您的文章「{article.title}」已通过审核，可以发布了",
        related_type="article",
        related_id=article_id
    )
    db.add(notification)
    
    # 操作日志
    log = LuchuOperationLog(
        user_id=current_user.id,
        action="approve",
        resource_type="article",
        resource_id=article_id,
        details=json.dumps({"comment": data.comment if data else None})
    )
    db.add(log)
    
    db.commit()
    db.refresh(review)
    
    logger.info(f"[Luchu] 用户 {current_user.username} 审核通过: {article.title}")
    
    return ReviewResponse(
        id=review.id,
        article_id=review.article_id,
        reviewer_id=review.reviewer_id,
        status=review.status,
        comment=review.comment,
        created_at=review.created_at
    )


@router.post("/{article_id}/reject", response_model=ReviewResponse)
async def reject_article(
    article_id: int,
    data: ReviewRequest,
    current_user: User = Depends(get_luchu_reviewer),
    db: Session = Depends(get_db)
):
    """审核驳回"""
    
    article = db.query(LuchuArticle).filter(LuchuArticle.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="文章不存在")
    
    if article.status != "pending":
        raise HTTPException(status_code=400, detail="文章状态不是待审核")
    
    if not data.comment:
        raise HTTPException(status_code=400, detail="驳回必须填写原因")
    
    # 更新状态
    article.status = "rejected"
    article.updated_at = datetime.utcnow()
    
    # 增加版本号并记录驳回原因
    article.version += 1
    version = LuchuArticleVersion(
        article_id=article.id,
        version_number=article.version,
        title=article.title,
        content=article.content,
        images=article.images,
        products=article.products,
        changed_by=current_user.id,
        change_type="review_reject",
        change_reason=data.comment
    )
    db.add(version)
    
    review = LuchuReview(
        article_id=article_id,
        reviewer_id=current_user.id,
        status="rejected",
        review_type="peer",
        comment=data.comment
    )
    db.add(review)
    
    # 发送通知给作者
    notification = LuchuNotification(
        user_id=article.author_id,
        type="review_rejected",
        title="文章审核被驳回",
        content=f"您的文章「{article.title}」被驳回，原因: {data.comment}",
        related_type="article",
        related_id=article_id
    )
    db.add(notification)
    
    # 操作日志
    log = LuchuOperationLog(
        user_id=current_user.id,
        action="reject",
        resource_type="article",
        resource_id=article_id,
        details=json.dumps({"comment": data.comment})
    )
    db.add(log)
    
    db.commit()
    db.refresh(review)
    
    logger.info(f"[Luchu] 用户 {current_user.username} 驳回文章: {article.title}, 原因: {data.comment}")
    
    return ReviewResponse(
        id=review.id,
        article_id=review.article_id,
        reviewer_id=review.reviewer_id,
        status=review.status,
        comment=review.comment,
        created_at=review.created_at
    )


@router.post("/{article_id}/self-check")
async def self_check_article(
    article_id: int,
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """自审通过（自审开关开启时，审核员可对自己的文章自审直接发布）"""
    from app.config import settings
    from app.middleware.auth import _get_luchu_reviewers

    if not settings.LUCHU_SELF_REVIEW_ENABLED:
        raise HTTPException(status_code=403, detail="自审功能尚未开启，请联系管理员")

    reviewers = _get_luchu_reviewers()
    if current_user.username not in reviewers and current_user.role != "manager":
        raise HTTPException(status_code=403, detail="您没有自审权限")

    article = db.query(LuchuArticle).filter(LuchuArticle.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="文章不存在")

    if article.author_id != current_user.id:
        raise HTTPException(status_code=403, detail="只能自审自己的文章")

    if article.status not in ["draft", "rejected"]:
        raise HTTPException(status_code=400, detail="只有草稿或被驳回的文章可以自审")

    article.status = "ready"
    article.updated_at = datetime.utcnow()

    review = LuchuReview(
        article_id=article_id,
        reviewer_id=current_user.id,
        status="self_checked",
        review_type="self",
        comment="自审通过"
    )
    db.add(review)

    log = LuchuOperationLog(
        user_id=current_user.id,
        action="self_check",
        resource_type="article",
        resource_id=article_id
    )
    db.add(log)

    db.commit()

    logger.info(f"[Luchu] 用户 {current_user.username} 自审通过: {article.title}")

    return {"message": "自审通过，文章已进入待发布状态"}

