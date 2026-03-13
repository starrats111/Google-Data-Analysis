"""
用户管理API
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import List

from app.database import get_db
from app.models.user import User
from app.models.site import PubSite
from app.models.user_site_binding import UserSiteBinding
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


# ── CR-008: 用户网站绑定 ──────────────────────────────────

class SiteBindRequest(BaseModel):
    site_id: int


@router.get("/me/sites")
async def get_my_sites(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取当前用户已绑定的网站"""
    bindings = (
        db.query(UserSiteBinding, PubSite)
        .join(PubSite, UserSiteBinding.site_id == PubSite.id)
        .filter(UserSiteBinding.user_id == current_user.id)
        .all()
    )
    bound = []
    for binding, site in bindings:
        bound.append({
            "id": site.id,
            "site_name": site.site_name,
            "domain": site.domain,
            "site_type": site.site_type,
            "bound_at": binding.created_at.isoformat() if binding.created_at else None,
        })
    return {"items": bound}


@router.get("/me/available-sites")
async def get_available_sites(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取当前用户可绑定的网站（本组内尚未绑定的）"""
    bound_ids = (
        db.query(UserSiteBinding.site_id)
        .filter(UserSiteBinding.user_id == current_user.id)
        .subquery()
    )
    sites = (
        db.query(PubSite)
        .filter(
            PubSite.group_id == current_user.team_id,
            PubSite.id.notin_(bound_ids),
        )
        .all()
    )
    return {"items": [
        {"id": s.id, "site_name": s.site_name, "domain": s.domain}
        for s in sites
    ]}


@router.post("/me/sites")
async def bind_site(
    data: SiteBindRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """绑定网站到当前用户"""
    site = db.query(PubSite).filter(PubSite.id == data.site_id).first()
    if not site:
        raise HTTPException(status_code=404, detail="网站不存在")

    if site.group_id != current_user.team_id and current_user.role not in ("manager", "leader"):
        raise HTTPException(status_code=403, detail="只能绑定本组的网站")

    existing = db.query(UserSiteBinding).filter(
        UserSiteBinding.user_id == current_user.id,
        UserSiteBinding.site_id == data.site_id,
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="已绑定此网站")

    binding = UserSiteBinding(user_id=current_user.id, site_id=data.site_id)
    db.add(binding)
    db.commit()
    return {"message": f"已绑定 {site.site_name}", "site_id": site.id}


@router.delete("/me/sites/{site_id}")
async def unbind_site(
    site_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """解绑网站"""
    binding = db.query(UserSiteBinding).filter(
        UserSiteBinding.user_id == current_user.id,
        UserSiteBinding.site_id == site_id,
    ).first()
    if not binding:
        raise HTTPException(status_code=404, detail="未绑定此网站")

    db.delete(binding)
    db.commit()
    return {"message": "已解绑"}

