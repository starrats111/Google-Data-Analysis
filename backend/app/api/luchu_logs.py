"""
露出操作日志 API（仅 wj02, wj07 可查看）
"""
import logging
from typing import List, Optional
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import desc

from app.database import get_db
from app.models.user import User
from app.models.luchu import LuchuOperationLog
from app.middleware.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/luchu/logs", tags=["luchu-logs"])


# 有权限查看日志的用户
ALLOWED_USERS = ['wj02', 'wj07']


@router.get("")
async def list_operation_logs(
    user_id: Optional[int] = Query(None, description="按用户筛选"),
    action: Optional[str] = Query(None, description="按操作类型筛选"),
    resource_type: Optional[str] = Query(None, description="按资源类型筛选"),
    days: int = Query(7, ge=1, le=90, description="最近天数"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取操作日志（仅 wj02, wj07 可查看）"""
    # 权限检查
    if current_user.username not in ALLOWED_USERS and current_user.role != 'manager':
        raise HTTPException(status_code=403, detail="无权查看操作日志")
    
    from datetime import timedelta
    
    # 构建查询
    query = db.query(LuchuOperationLog)
    
    # 时间范围
    start_date = datetime.utcnow() - timedelta(days=days)
    query = query.filter(LuchuOperationLog.created_at >= start_date)
    
    if user_id:
        query = query.filter(LuchuOperationLog.user_id == user_id)
    
    if action:
        query = query.filter(LuchuOperationLog.action == action)
    
    if resource_type:
        query = query.filter(LuchuOperationLog.resource_type == resource_type)
    
    query = query.order_by(desc(LuchuOperationLog.created_at))
    
    total = query.count()
    logs = query.offset((page - 1) * page_size).limit(page_size).all()
    
    # 构建响应
    result = []
    for log in logs:
        user = db.query(User).filter(User.id == log.user_id).first()
        result.append({
            "id": log.id,
            "user_id": log.user_id,
            "username": user.username if user else None,
            "display_name": user.display_name if user else None,
            "action": log.action,
            "resource_type": log.resource_type,
            "resource_id": log.resource_id,
            "details": log.details,
            "ip_address": log.ip_address,
            "created_at": log.created_at.isoformat() if log.created_at else None
        })
    
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": result
    }


@router.get("/actions")
async def get_action_types(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取所有操作类型（用于筛选下拉框）"""
    if current_user.username not in ALLOWED_USERS and current_user.role != 'manager':
        raise HTTPException(status_code=403, detail="无权访问")
    
    from sqlalchemy import distinct
    
    actions = db.query(distinct(LuchuOperationLog.action)).all()
    
    action_labels = {
        "create": "创建",
        "edit": "编辑",
        "delete": "删除",
        "submit": "提交审核",
        "approve": "审核通过",
        "reject": "审核驳回",
        "self_check": "自检通过",
        "publish": "发布",
        "restore": "恢复版本",
        "resolve_alert": "处理告警"
    }
    
    return [{
        "value": a[0],
        "label": action_labels.get(a[0], a[0])
    } for a in actions if a[0]]


@router.get("/resource-types")
async def get_resource_types(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取所有资源类型（用于筛选下拉框）"""
    if current_user.username not in ALLOWED_USERS and current_user.role != 'manager':
        raise HTTPException(status_code=403, detail="无权访问")
    
    from sqlalchemy import distinct
    
    types = db.query(distinct(LuchuOperationLog.resource_type)).all()
    
    type_labels = {
        "article": "文章",
        "prompt_template": "提示词模板",
        "website": "网站配置",
        "image_alert": "图片告警"
    }
    
    return [{
        "value": t[0],
        "label": type_labels.get(t[0], t[0])
    } for t in types if t[0]]

