"""
露出发布管理 API
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
    LuchuArticle, LuchuWebsite, LuchuPublishLog,
    LuchuNotification, LuchuOperationLog
)
from app.schemas.luchu import PublishRequest, PublishResponse, LuchuArticleListResponse
from app.middleware.auth import get_current_user
from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/luchu/publish", tags=["luchu-publish"])


@router.get("/ready", response_model=List[LuchuArticleListResponse])
async def list_ready_to_publish(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取待发布列表"""
    query = db.query(LuchuArticle).filter(LuchuArticle.status == "ready")
    
    # 普通用户只能看自己的
    if current_user.role not in ['manager', 'leader']:
        query = query.filter(LuchuArticle.author_id == current_user.id)
    
    query = query.order_by(desc(LuchuArticle.updated_at))
    
    total = query.count()
    articles = query.offset((page - 1) * page_size).limit(page_size).all()
    
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


@router.post("/{article_id}", response_model=PublishResponse)
async def publish_article(
    article_id: int,
    data: PublishRequest = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """发布文章到 GitHub"""
    article = db.query(LuchuArticle).filter(LuchuArticle.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="文章不存在")
    
    # 权限检查：只能发布自己的文章，或者管理员/组长可以发布所有
    if current_user.role not in ['manager', 'leader'] and article.author_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权发布此文章")
    
    if article.status != "ready":
        raise HTTPException(status_code=400, detail="文章状态不是待发布")
    
    # 获取网站配置
    website = db.query(LuchuWebsite).filter(LuchuWebsite.id == article.website_id).first()
    if not website:
        raise HTTPException(status_code=404, detail="网站配置不存在")
    
    # 检查 GitHub Token
    if not settings.GITHUB_TOKEN:
        raise HTTPException(status_code=500, detail="GitHub Token 未配置")
    
    try:
        from app.services.github_service import get_github_service
        
        github = get_github_service(settings.GITHUB_TOKEN)
        
        # 构建文章数据
        images = {}
        if article.images:
            try:
                images = json.loads(article.images)
            except:
                images = {}
        
        products = []
        if article.products:
            try:
                products = json.loads(article.products)
            except:
                products = []
        
        article_data = {
            "id": article.id,
            "title": article.title,
            "slug": article.slug or f"article-{article.id}",
            "category": article.category,
            "categoryName": article.category_name,
            "excerpt": article.excerpt,
            "content": article.content,
            "date": article.publish_date.isoformat() if article.publish_date else datetime.now().strftime("%Y-%m-%d"),
            "images": images,
            "products": products,
            "brandName": article.brand_name,
            "trackingLink": article.tracking_link
        }
        
        commit_message = data.commit_message if data else None
        
        # 发布到 GitHub
        result = await github.publish_article(
            repo=website.github_repo,
            article_id=article.id,
            article_data=article_data,
            data_path=website.data_path,
            commit_message=commit_message
        )
        
        if result.get("success"):
            # 更新文章状态
            article.status = "published"
            article.published_at = datetime.utcnow()
            article.updated_at = datetime.utcnow()
            
            # 创建发布日志
            publish_log = LuchuPublishLog(
                article_id=article.id,
                website_id=website.id,
                operator_id=current_user.id,
                commit_sha=result.get("commit_sha"),
                file_path=result.get("file_path"),
                status="success"
            )
            db.add(publish_log)
            
            # 发送通知
            notification = LuchuNotification(
                user_id=article.author_id,
                type="publish_success",
                title="文章发布成功",
                content=f"您的文章「{article.title}」已成功发布到 {website.name}",
                related_type="article",
                related_id=article.id
            )
            db.add(notification)
            
            # 操作日志
            log = LuchuOperationLog(
                user_id=current_user.id,
                action="publish",
                resource_type="article",
                resource_id=article.id,
                details=json.dumps({
                    "website": website.name,
                    "commit_sha": result.get("commit_sha")
                })
            )
            db.add(log)
            
            db.commit()
            
            logger.info(f"[Luchu] 用户 {current_user.username} 发布文章: {article.title} -> {website.name}")
            
            # 构建文章URL
            article_url = f"{website.site_url}/article.html?id={article.id}" if website.site_url else None
            
            return PublishResponse(
                success=True,
                commit_sha=result.get("commit_sha"),
                file_path=result.get("file_path"),
                article_url=article_url
            )
        else:
            # 发布失败
            publish_log = LuchuPublishLog(
                article_id=article.id,
                website_id=website.id,
                operator_id=current_user.id,
                status="failed",
                error_message=result.get("error")
            )
            db.add(publish_log)
            db.commit()
            
            logger.error(f"[Luchu] 发布失败: {result.get('error')}")
            
            return PublishResponse(
                success=False,
                error=result.get("error")
            )
            
    except Exception as e:
        logger.error(f"[Luchu] 发布异常: {e}")
        
        # 记录失败
        publish_log = LuchuPublishLog(
            article_id=article.id,
            website_id=website.id,
            operator_id=current_user.id,
            status="failed",
            error_message=str(e)
        )
        db.add(publish_log)
        db.commit()
        
        return PublishResponse(
            success=False,
            error=str(e)
        )


@router.get("/logs")
async def get_publish_logs(
    article_id: int = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取发布日志"""
    query = db.query(LuchuPublishLog)
    
    if article_id:
        query = query.filter(LuchuPublishLog.article_id == article_id)
    
    # 普通用户只能看自己文章的日志
    if current_user.role not in ['manager', 'leader']:
        subquery = db.query(LuchuArticle.id).filter(
            LuchuArticle.author_id == current_user.id
        )
        query = query.filter(LuchuPublishLog.article_id.in_(subquery))
    
    query = query.order_by(desc(LuchuPublishLog.created_at))
    
    total = query.count()
    logs = query.offset((page - 1) * page_size).limit(page_size).all()
    
    result = []
    for log in logs:
        article = db.query(LuchuArticle).filter(LuchuArticle.id == log.article_id).first()
        website = db.query(LuchuWebsite).filter(LuchuWebsite.id == log.website_id).first()
        operator = db.query(User).filter(User.id == log.operator_id).first()
        
        result.append({
            "id": log.id,
            "article_id": log.article_id,
            "article_title": article.title if article else None,
            "website_id": log.website_id,
            "website_name": website.name if website else None,
            "operator_id": log.operator_id,
            "operator_name": operator.display_name or operator.username if operator else None,
            "commit_sha": log.commit_sha,
            "file_path": log.file_path,
            "status": log.status,
            "error_message": log.error_message,
            "created_at": log.created_at.isoformat() if log.created_at else None
        })
    
    return {
        "total": total,
        "items": result
    }

