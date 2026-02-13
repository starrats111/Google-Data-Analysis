"""
露出网站配置 API
"""
import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.luchu import LuchuWebsite
from app.schemas.luchu import LuchuWebsiteCreate, LuchuWebsiteResponse
from app.middleware.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/luchu/websites", tags=["luchu-websites"])


@router.get("", response_model=List[LuchuWebsiteResponse])
async def list_websites(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取网站列表"""
    query = db.query(LuchuWebsite).filter(LuchuWebsite.is_active == 1)
    
    # 普通用户只能看到自己负责的网站
    if current_user.role not in ['manager', 'leader']:
        query = query.filter(LuchuWebsite.owner_id == current_user.id)
    
    websites = query.order_by(LuchuWebsite.id).all()
    
    return [LuchuWebsiteResponse(
        id=w.id,
        name=w.name,
        domain=w.domain,
        owner_id=w.owner_id,
        github_repo=w.github_repo,
        data_path=w.data_path,
        has_products=bool(w.has_products),
        site_url=w.site_url,
        is_active=bool(w.is_active),
        created_at=w.created_at
    ) for w in websites]


@router.get("/{website_id}", response_model=LuchuWebsiteResponse)
async def get_website(
    website_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取网站详情"""
    website = db.query(LuchuWebsite).filter(LuchuWebsite.id == website_id).first()
    if not website:
        raise HTTPException(status_code=404, detail="网站不存在")
    
    return LuchuWebsiteResponse(
        id=website.id,
        name=website.name,
        domain=website.domain,
        owner_id=website.owner_id,
        github_repo=website.github_repo,
        data_path=website.data_path,
        has_products=bool(website.has_products),
        site_url=website.site_url,
        is_active=bool(website.is_active),
        created_at=website.created_at
    )


@router.put("/{website_id}", response_model=LuchuWebsiteResponse)
async def update_website(
    website_id: int,
    data: LuchuWebsiteCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """更新网站配置（仅管理员）"""
    if current_user.role != 'manager':
        raise HTTPException(status_code=403, detail="仅管理员可修改网站配置")
    
    website = db.query(LuchuWebsite).filter(LuchuWebsite.id == website_id).first()
    if not website:
        raise HTTPException(status_code=404, detail="网站不存在")
    
    website.name = data.name
    website.domain = data.domain
    website.github_repo = data.github_repo
    website.data_path = data.data_path
    website.has_products = 1 if data.has_products else 0
    website.site_url = data.site_url
    website.is_active = 1 if data.is_active else 0
    
    if data.owner_id:
        website.owner_id = data.owner_id
    
    db.commit()
    db.refresh(website)
    
    logger.info(f"[Luchu] 更新网站配置: {website.name}")
    
    return LuchuWebsiteResponse(
        id=website.id,
        name=website.name,
        domain=website.domain,
        owner_id=website.owner_id,
        github_repo=website.github_repo,
        data_path=website.data_path,
        has_products=bool(website.has_products),
        site_url=website.site_url,
        is_active=bool(website.is_active),
        created_at=website.created_at
    )


@router.post("", response_model=LuchuWebsiteResponse)
async def create_website(
    data: LuchuWebsiteCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """创建网站配置（仅管理员）"""
    if current_user.role != 'manager':
        raise HTTPException(status_code=403, detail="仅管理员可创建网站")
    
    website = LuchuWebsite(
        name=data.name,
        domain=data.domain,
        owner_id=data.owner_id,
        github_repo=data.github_repo,
        data_path=data.data_path,
        has_products=1 if data.has_products else 0,
        site_url=data.site_url,
        is_active=1 if data.is_active else 0
    )
    
    db.add(website)
    db.commit()
    db.refresh(website)
    
    logger.info(f"[Luchu] 创建网站: {website.name}")
    
    return LuchuWebsiteResponse(
        id=website.id,
        name=website.name,
        domain=website.domain,
        owner_id=website.owner_id,
        github_repo=website.github_repo,
        data_path=website.data_path,
        has_products=bool(website.has_products),
        site_url=website.site_url,
        is_active=bool(website.is_active),
        created_at=website.created_at
    )

