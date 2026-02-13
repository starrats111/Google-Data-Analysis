"""
露出文章 API
"""
import json
import logging
from typing import List, Optional
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import desc, func

from app.database import get_db
from app.models.user import User
from app.models.luchu import (
    LuchuArticle, LuchuWebsite, LuchuArticleVersion,
    LuchuNotification, LuchuOperationLog
)
from app.schemas.luchu import (
    LuchuArticleCreate, LuchuArticleUpdate, LuchuArticleResponse,
    LuchuArticleListResponse, ArticleVersionResponse
)
from app.middleware.auth import get_current_user, get_luchu_authorized_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/luchu/articles", tags=["luchu-articles"])


@router.get("", response_model=List[LuchuArticleListResponse])
async def list_articles(
    status: Optional[str] = Query(None, description="状态筛选"),
    website_id: Optional[int] = Query(None, description="网站筛选"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """获取文章列表"""
    query = db.query(LuchuArticle)
    
    # 普通用户只能看自己的文章
    if current_user.role not in ['manager', 'leader']:
        query = query.filter(LuchuArticle.author_id == current_user.id)
    
    if status:
        query = query.filter(LuchuArticle.status == status)
    
    if website_id:
        query = query.filter(LuchuArticle.website_id == website_id)
    
    query = query.order_by(desc(LuchuArticle.created_at))
    
    # 分页
    total = query.count()
    articles = query.offset((page - 1) * page_size).limit(page_size).all()
    
    # 构建响应
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


@router.post("", response_model=LuchuArticleResponse)
async def create_article(
    data: LuchuArticleCreate,
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """创建文章"""
    # 验证网站存在
    website = db.query(LuchuWebsite).filter(LuchuWebsite.id == data.website_id).first()
    if not website:
        raise HTTPException(status_code=404, detail="网站不存在")
    
    # 创建文章
    article = LuchuArticle(
        website_id=data.website_id,
        author_id=current_user.id,
        title=data.title,
        slug=data.slug,
        category=data.category,
        category_name=data.category_name,
        excerpt=data.excerpt,
        content=data.content,
        images=json.dumps(data.images) if data.images else None,
        products=json.dumps(data.products) if data.products else None,
        merchant_url=data.merchant_url,
        tracking_link=data.tracking_link,
        brand_name=data.brand_name,
        brand_keyword=data.brand_keyword,
        keyword_count=data.keyword_count,
        target_country=data.target_country or "US",
        target_language=data.target_language or "en-US",
        publish_date=data.publish_date,
        status="draft",
        version=1
    )
    
    db.add(article)
    db.commit()
    db.refresh(article)
    
    # 创建版本记录
    version = LuchuArticleVersion(
        article_id=article.id,
        version_number=1,
        title=article.title,
        content=article.content,
        images=article.images,
        products=article.products,
        changed_by=current_user.id,
        change_type="create"
    )
    db.add(version)
    
    # 操作日志
    log = LuchuOperationLog(
        user_id=current_user.id,
        action="create",
        resource_type="article",
        resource_id=article.id,
        details=json.dumps({"title": article.title})
    )
    db.add(log)
    
    db.commit()
    
    logger.info(f"[Luchu] 用户 {current_user.username} 创建文章: {article.title}")
    
    return _article_to_response(article)


@router.get("/{article_id}", response_model=LuchuArticleResponse)
async def get_article(
    article_id: int,
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """获取文章详情"""
    article = db.query(LuchuArticle).filter(LuchuArticle.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="文章不存在")
    
    # 权限检查
    if current_user.role not in ['manager', 'leader'] and article.author_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权访问此文章")
    
    return _article_to_response(article)


@router.put("/{article_id}", response_model=LuchuArticleResponse)
async def update_article(
    article_id: int,
    data: LuchuArticleUpdate,
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """更新文章"""
    article = db.query(LuchuArticle).filter(LuchuArticle.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="文章不存在")
    
    # 权限检查
    if current_user.role not in ['manager', 'leader'] and article.author_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权修改此文章")
    
    # 已发布的文章不能修改
    if article.status == "published":
        raise HTTPException(status_code=400, detail="已发布的文章不能修改")
    
    # 更新字段
    update_data = data.model_dump(exclude_unset=True)
    
    if 'images' in update_data and update_data['images'] is not None:
        update_data['images'] = json.dumps(update_data['images'])
    
    if 'products' in update_data and update_data['products'] is not None:
        update_data['products'] = json.dumps(update_data['products'])
    
    for key, value in update_data.items():
        setattr(article, key, value)
    
    # 增加版本号
    article.version += 1
    article.updated_at = datetime.utcnow()
    
    # 创建版本记录
    version = LuchuArticleVersion(
        article_id=article.id,
        version_number=article.version,
        title=article.title,
        content=article.content,
        images=article.images,
        products=article.products,
        changed_by=current_user.id,
        change_type="edit"
    )
    db.add(version)
    
    # 操作日志
    log = LuchuOperationLog(
        user_id=current_user.id,
        action="edit",
        resource_type="article",
        resource_id=article.id,
        details=json.dumps({"version": article.version})
    )
    db.add(log)
    
    db.commit()
    db.refresh(article)
    
    logger.info(f"[Luchu] 用户 {current_user.username} 更新文章: {article.title} (v{article.version})")
    
    return _article_to_response(article)


@router.delete("/{article_id}")
async def delete_article(
    article_id: int,
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """删除文章"""
    article = db.query(LuchuArticle).filter(LuchuArticle.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="文章不存在")
    
    # 权限检查
    if current_user.role not in ['manager', 'leader'] and article.author_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权删除此文章")
    
    # 已发布的文章不能删除
    if article.status == "published":
        raise HTTPException(status_code=400, detail="已发布的文章不能删除")
    
    title = article.title
    
    # 删除相关记录
    db.query(LuchuArticleVersion).filter(LuchuArticleVersion.article_id == article_id).delete()
    db.delete(article)
    
    # 操作日志
    log = LuchuOperationLog(
        user_id=current_user.id,
        action="delete",
        resource_type="article",
        resource_id=article_id,
        details=json.dumps({"title": title})
    )
    db.add(log)
    
    db.commit()
    
    logger.info(f"[Luchu] 用户 {current_user.username} 删除文章: {title}")
    
    return {"message": "删除成功"}


@router.post("/{article_id}/submit")
async def submit_for_review(
    article_id: int,
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """提交审核"""
    article = db.query(LuchuArticle).filter(LuchuArticle.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="文章不存在")
    
    if article.author_id != current_user.id:
        raise HTTPException(status_code=403, detail="只能提交自己的文章")
    
    if article.status not in ['draft', 'rejected']:
        raise HTTPException(status_code=400, detail="只有草稿或被驳回的文章可以提交审核")
    
    article.status = "pending"
    article.updated_at = datetime.utcnow()
    
    # 操作日志
    log = LuchuOperationLog(
        user_id=current_user.id,
        action="submit",
        resource_type="article",
        resource_id=article.id
    )
    db.add(log)
    
    db.commit()
    
    logger.info(f"[Luchu] 用户 {current_user.username} 提交审核: {article.title}")
    
    return {"message": "已提交审核"}


@router.get("/{article_id}/versions", response_model=List[ArticleVersionResponse])
async def get_article_versions(
    article_id: int,
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """获取文章版本历史"""
    article = db.query(LuchuArticle).filter(LuchuArticle.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="文章不存在")
    
    # 权限检查
    if current_user.role not in ['manager', 'leader'] and article.author_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权访问此文章")
    
    versions = db.query(LuchuArticleVersion).filter(
        LuchuArticleVersion.article_id == article_id
    ).order_by(desc(LuchuArticleVersion.version_number)).all()
    
    result = []
    for v in versions:
        changer = db.query(User).filter(User.id == v.changed_by).first()
        result.append(ArticleVersionResponse(
            id=v.id,
            article_id=v.article_id,
            version_number=v.version_number,
            title=v.title,
            change_type=v.change_type,
            change_reason=v.change_reason,
            changed_by=v.changed_by,
            changer_name=changer.display_name or changer.username if changer else None,
            created_at=v.created_at
        ))
    
    return result


@router.post("/{article_id}/versions/{version_number}/restore")
async def restore_version(
    article_id: int,
    version_number: int,
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """恢复到某个版本"""
    article = db.query(LuchuArticle).filter(LuchuArticle.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="文章不存在")
    
    # 权限检查
    if current_user.role not in ['manager', 'leader'] and article.author_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权修改此文章")
    
    # 获取目标版本
    target_version = db.query(LuchuArticleVersion).filter(
        LuchuArticleVersion.article_id == article_id,
        LuchuArticleVersion.version_number == version_number
    ).first()
    
    if not target_version:
        raise HTTPException(status_code=404, detail="版本不存在")
    
    # 恢复内容
    article.title = target_version.title
    article.content = target_version.content
    article.images = target_version.images
    article.products = target_version.products
    article.version += 1
    article.updated_at = datetime.utcnow()
    
    # 创建新版本记录
    new_version = LuchuArticleVersion(
        article_id=article.id,
        version_number=article.version,
        title=article.title,
        content=article.content,
        images=article.images,
        products=article.products,
        changed_by=current_user.id,
        change_type="restore",
        change_reason=f"恢复到版本 {version_number}"
    )
    db.add(new_version)
    
    # 操作日志
    log = LuchuOperationLog(
        user_id=current_user.id,
        action="restore",
        resource_type="article",
        resource_id=article.id,
        details=json.dumps({"from_version": version_number, "to_version": article.version})
    )
    db.add(log)
    
    db.commit()
    
    logger.info(f"[Luchu] 用户 {current_user.username} 恢复文章到版本 {version_number}")
    
    return {"message": f"已恢复到版本 {version_number}"}


def _article_to_response(article: LuchuArticle) -> LuchuArticleResponse:
    """将文章模型转换为响应"""
    images = None
    if article.images:
        try:
            images = json.loads(article.images)
        except:
            images = None
    
    products = None
    if article.products:
        try:
            products = json.loads(article.products)
        except:
            products = None
    
    return LuchuArticleResponse(
        id=article.id,
        website_id=article.website_id,
        author_id=article.author_id,
        title=article.title,
        slug=article.slug,
        category=article.category,
        category_name=article.category_name,
        excerpt=article.excerpt,
        content=article.content,
        images=images,
        products=products,
        merchant_url=article.merchant_url,
        tracking_link=article.tracking_link,
        brand_name=article.brand_name,
        brand_keyword=article.brand_keyword,
        keyword_count=article.keyword_count,
        target_country=article.target_country or "US",
        target_language=article.target_language or "en-US",
        status=article.status,
        publish_date=article.publish_date,
        version=article.version,
        created_at=article.created_at,
        updated_at=article.updated_at,
        published_at=article.published_at
    )

