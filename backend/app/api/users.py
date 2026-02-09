"""
用户管理API
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from app.database import get_db
from app.models.user import User
from app.middleware.auth import get_current_user

router = APIRouter(prefix="/api/users", tags=["users"])


def get_current_manager(current_user: User = Depends(get_current_user)):
    """验证当前用户是否为经理"""
    if current_user.role != "manager":
        raise HTTPException(status_code=403, detail="只有经理可以访问此接口")
    return current_user


@router.get("/{user_id}")
async def get_user_by_id(
    user_id: int,
    current_user: User = Depends(get_current_manager),
    db: Session = Depends(get_db)
):
    """获取指定用户信息（经理专用）"""
    user = db.query(User).filter(User.id == user_id).first()
    
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    
    return {
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "real_name": getattr(user, 'real_name', None),
        "email": getattr(user, 'email', None),
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }


@router.get("/")
async def get_all_users(
    current_user: User = Depends(get_current_manager),
    db: Session = Depends(get_db)
):
    """获取所有用户列表（经理专用）"""
    users = db.query(User).all()
    
    return [{
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "real_name": getattr(user, 'real_name', None),
        "email": getattr(user, 'email', None),
        "created_at": user.created_at.isoformat() if user.created_at else None,
    } for user in users]

