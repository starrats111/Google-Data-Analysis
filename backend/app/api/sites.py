"""
网站配置管理 API（OPT-013）
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.site import PubSite
from app.services import site_publisher

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/sites", tags=["网站管理"])


class SiteCreate(BaseModel):
    site_name: str
    domain: str
    data_js_path: str = "js/articles-index.js"
    article_template: str = "article-1.html"
    group_id: Optional[int] = None


class SiteUpdate(BaseModel):
    site_name: Optional[str] = None
    domain: Optional[str] = None


def _check_site_permission(site: PubSite, user: User):
    if user.role in ("manager", "leader"):
        return
    if site.created_by != user.id:
        raise HTTPException(status_code=403, detail="无权操作此网站配置")


def _site_to_dict(site: PubSite, db: Session) -> dict:
    creator = db.query(User).filter(User.id == site.created_by).first()
    return {
        "id": site.id,
        "group_id": site.group_id,
        "site_name": site.site_name,
        "site_path": site.site_path,
        "domain": site.domain,
        "data_js_path": site.data_js_path,
        "article_template": site.article_template,
        "migrated": site.migrated,
        "created_by": site.created_by,
        "created_by_name": creator.display_name or creator.username if creator else None,
        "created_at": site.created_at.isoformat() if site.created_at else None,
    }


@router.get("")
async def list_sites(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取当前用户组的网站列表"""
    if current_user.role in ("manager", "leader"):
        sites = db.query(PubSite).all()
    else:
        sites = db.query(PubSite).filter(PubSite.group_id == current_user.team_id).all()
    return {"items": [_site_to_dict(s, db) for s in sites]}


@router.post("")
async def create_site(
    data: SiteCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """新增网站配置，自动创建目录结构"""
    # 根据域名自动生成路径
    domain_clean = data.domain.strip().lower().replace("https://", "").replace("http://", "").rstrip("/")
    dir_name = domain_clean.replace(".", "-")  # allurahub.com -> allurahub-com
    site_path = f"/home/admin/sites/{dir_name}"

    # 检查是否已存在同域名的网站
    existing = db.query(PubSite).filter(PubSite.domain == domain_clean).first()
    if existing:
        raise HTTPException(status_code=400, detail=f"域名 {domain_clean} 已被注册")

    # 自动创建目录结构
    try:
        site_publisher.init_site_directory(site_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"创建网站目录失败: {e}")

    group_id = data.group_id if (data.group_id and current_user.role in ("manager", "leader")) else current_user.team_id

    site = PubSite(
        group_id=group_id,
        site_name=data.site_name.strip(),
        site_path=site_path,
        domain=domain_clean,
        data_js_path=data.data_js_path,
        article_template=data.article_template,
        created_by=current_user.id,
        migrated=False,
    )
    db.add(site)
    db.commit()
    db.refresh(site)

    # 对已有文章执行 slug 迁移
    migration_result = {"migrated_count": 0, "errors": []}
    try:
        migration_result = site_publisher.migrate_to_slug(site)
        site.migrated = True
        db.commit()
    except Exception as e:
        logger.warning(f"Slug 迁移跳过（目录可能为空）: {e}")
        site.migrated = True
        db.commit()

    result = _site_to_dict(site, db)
    result["migration"] = migration_result
    return result


@router.put("/{site_id}")
async def update_site(
    site_id: int,
    data: SiteUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    site = db.query(PubSite).filter(PubSite.id == site_id).first()
    if not site:
        raise HTTPException(status_code=404, detail="网站不存在")
    _check_site_permission(site, current_user)

    update_data = data.dict(exclude_unset=True)
    if "domain" in update_data:
        domain_clean = update_data["domain"].strip().lower().replace("https://", "").replace("http://", "").rstrip("/")
        update_data["domain"] = domain_clean

    for key, value in update_data.items():
        setattr(site, key, value)

    db.commit()
    db.refresh(site)
    return _site_to_dict(site, db)


@router.delete("/{site_id}")
async def delete_site(
    site_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    site = db.query(PubSite).filter(PubSite.id == site_id).first()
    if not site:
        raise HTTPException(status_code=404, detail="网站不存在")
    _check_site_permission(site, current_user)

    db.delete(site)
    db.commit()
    return {"message": "网站配置已删除"}


@router.post("/{site_id}/verify")
async def verify_site(
    site_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    site = db.query(PubSite).filter(PubSite.id == site_id).first()
    if not site:
        raise HTTPException(status_code=404, detail="网站不存在")

    checks = site_publisher.verify_site(site.site_path)
    return {"site_id": site_id, "site_name": site.site_name, "checks": checks}
