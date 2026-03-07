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
    site_path: str
    domain: Optional[str] = None
    data_js_path: str = "js/articles-index.js"
    article_template: str = "article-1.html"
    group_id: Optional[int] = None


class SiteUpdate(BaseModel):
    site_name: Optional[str] = None
    site_path: Optional[str] = None
    domain: Optional[str] = None
    data_js_path: Optional[str] = None
    article_template: Optional[str] = None


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
    """新增网站配置，自动触发 slug 迁移"""
    # 所有员工都可以创建自己的网站配置

    try:
        site_publisher.validate_site_path(data.site_path)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    checks = site_publisher.verify_site(data.site_path)
    if not checks["valid"]:
        failed = [k for k, v in checks.items() if not v and k != "valid"]
        raise HTTPException(status_code=400, detail=f"网站目录验证失败: {', '.join(failed)}")

    group_id = data.group_id if (data.group_id and current_user.role in ("manager", "leader")) else current_user.team_id

    site = PubSite(
        group_id=group_id,
        site_name=data.site_name,
        site_path=data.site_path,
        domain=data.domain,
        data_js_path=data.data_js_path,
        article_template=data.article_template,
        created_by=current_user.id,
    )
    db.add(site)
    db.flush()

    migration_result = None
    try:
        migration_result = site_publisher.migrate_to_slug(site)
        site.migrated = True
    except Exception as e:
        logger.error(f"Slug 迁移失败: {e}", exc_info=True)
        migration_result = {"migrated_count": 0, "errors": [str(e)]}

    db.commit()
    db.refresh(site)

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

    if "site_path" in update_data:
        try:
            site_publisher.validate_site_path(update_data["site_path"])
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

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
