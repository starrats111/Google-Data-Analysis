"""
露出提示词模板管理 API
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
from app.models.luchu import LuchuPromptTemplate, LuchuOperationLog
from app.schemas.luchu import PromptTemplateCreate, PromptTemplateResponse
from app.middleware.auth import get_current_user, get_luchu_authorized_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/luchu/prompts", tags=["luchu-prompts"])


@router.get("", response_model=List[PromptTemplateResponse])
async def list_prompt_templates(
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """获取提示词模板列表"""
    templates = db.query(LuchuPromptTemplate).order_by(
        desc(LuchuPromptTemplate.is_default),
        LuchuPromptTemplate.id
    ).all()
    
    return [PromptTemplateResponse(
        id=t.id,
        name=t.name,
        description=t.description,
        category=t.category,
        has_products=bool(t.has_products),
        template_content=t.template_content,
        is_default=bool(t.is_default),
        website_id=t.website_id,
        created_by=t.created_by,
        created_at=t.created_at
    ) for t in templates]


@router.get("/{template_id}", response_model=PromptTemplateResponse)
async def get_prompt_template(
    template_id: int,
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """获取提示词模板详情"""
    template = db.query(LuchuPromptTemplate).filter(
        LuchuPromptTemplate.id == template_id
    ).first()
    
    if not template:
        raise HTTPException(status_code=404, detail="模板不存在")
    
    return PromptTemplateResponse(
        id=template.id,
        name=template.name,
        description=template.description,
        category=template.category,
        has_products=bool(template.has_products),
        template_content=template.template_content,
        is_default=bool(template.is_default),
        website_id=template.website_id,
        created_by=template.created_by,
        created_at=template.created_at
    )


@router.post("", response_model=PromptTemplateResponse)
async def create_prompt_template(
    data: PromptTemplateCreate,
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """创建提示词模板（仅管理员）"""
    if current_user.role != 'manager':
        raise HTTPException(status_code=403, detail="仅管理员可创建模板")
    
    template = LuchuPromptTemplate(
        name=data.name,
        description=data.description,
        website_id=data.website_id,
        category=data.category,
        has_products=1 if data.has_products else 0,
        template_content=data.template_content,
        is_default=1 if data.is_default else 0,
        created_by=current_user.id
    )
    
    # 如果设为默认，取消其他默认
    if data.is_default:
        db.query(LuchuPromptTemplate).filter(
            LuchuPromptTemplate.is_default == 1
        ).update({"is_default": 0})
    
    db.add(template)
    
    # 操作日志
    log = LuchuOperationLog(
        user_id=current_user.id,
        action="create",
        resource_type="prompt_template",
        resource_id=template.id,
        details=json.dumps({"name": template.name})
    )
    db.add(log)
    
    db.commit()
    db.refresh(template)
    
    logger.info(f"[Luchu] 创建提示词模板: {template.name}")
    
    return PromptTemplateResponse(
        id=template.id,
        name=template.name,
        description=template.description,
        category=template.category,
        has_products=bool(template.has_products),
        template_content=template.template_content,
        is_default=bool(template.is_default),
        website_id=template.website_id,
        created_by=template.created_by,
        created_at=template.created_at
    )


@router.put("/{template_id}", response_model=PromptTemplateResponse)
async def update_prompt_template(
    template_id: int,
    data: PromptTemplateCreate,
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """更新提示词模板（仅管理员）"""
    if current_user.role != 'manager':
        raise HTTPException(status_code=403, detail="仅管理员可修改模板")
    
    template = db.query(LuchuPromptTemplate).filter(
        LuchuPromptTemplate.id == template_id
    ).first()
    
    if not template:
        raise HTTPException(status_code=404, detail="模板不存在")
    
    template.name = data.name
    template.description = data.description
    template.website_id = data.website_id
    template.category = data.category
    template.has_products = 1 if data.has_products else 0
    template.template_content = data.template_content
    template.updated_at = datetime.utcnow()
    
    # 如果设为默认，取消其他默认
    if data.is_default:
        db.query(LuchuPromptTemplate).filter(
            LuchuPromptTemplate.id != template_id,
            LuchuPromptTemplate.is_default == 1
        ).update({"is_default": 0})
        template.is_default = 1
    else:
        template.is_default = 0
    
    # 操作日志
    log = LuchuOperationLog(
        user_id=current_user.id,
        action="edit",
        resource_type="prompt_template",
        resource_id=template.id,
        details=json.dumps({"name": template.name})
    )
    db.add(log)
    
    db.commit()
    db.refresh(template)
    
    logger.info(f"[Luchu] 更新提示词模板: {template.name}")
    
    return PromptTemplateResponse(
        id=template.id,
        name=template.name,
        description=template.description,
        category=template.category,
        has_products=bool(template.has_products),
        template_content=template.template_content,
        is_default=bool(template.is_default),
        website_id=template.website_id,
        created_by=template.created_by,
        created_at=template.created_at
    )


@router.delete("/{template_id}")
async def delete_prompt_template(
    template_id: int,
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """删除提示词模板（仅管理员）"""
    if current_user.role != 'manager':
        raise HTTPException(status_code=403, detail="仅管理员可删除模板")
    
    template = db.query(LuchuPromptTemplate).filter(
        LuchuPromptTemplate.id == template_id
    ).first()
    
    if not template:
        raise HTTPException(status_code=404, detail="模板不存在")
    
    if template.is_default:
        raise HTTPException(status_code=400, detail="不能删除默认模板")
    
    name = template.name
    db.delete(template)
    
    # 操作日志
    log = LuchuOperationLog(
        user_id=current_user.id,
        action="delete",
        resource_type="prompt_template",
        resource_id=template_id,
        details=json.dumps({"name": name})
    )
    db.add(log)
    
    db.commit()
    
    logger.info(f"[Luchu] 删除提示词模板: {name}")
    
    return {"message": "删除成功"}

