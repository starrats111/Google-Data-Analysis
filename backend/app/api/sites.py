"""
网站配置管理 API（OPT-013 / CR-035）
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.site import PubSite
from app.services import site_publisher
from app.services.remote_publisher import remote_publisher

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/sites", tags=["网站管理"])


class SiteCreate(BaseModel):
    site_name: str
    domain: str
    data_js_path: str = "assets/js/main.js"
    article_template: str = ""
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
        "site_type": site.site_type,
        "data_js_path": site.data_js_path,
        "article_var_name": site.article_var_name,
        "article_html_pattern": site.article_html_pattern,
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
    """新增网站配置（CR-035：使用宝塔远程路径）"""
    domain_clean = data.domain.strip().lower().replace("https://", "").replace("http://", "").rstrip("/")

    # 检查是否已存在同域名的网站
    existing = db.query(PubSite).filter(PubSite.domain == domain_clean).first()
    if existing:
        raise HTTPException(status_code=400, detail=f"域名 {domain_clean} 已被注册")

    # 宝塔远程路径
    bt_root = getattr(settings, "BT_SITE_ROOT", "/www/wwwroot")
    site_path = f"{bt_root}/{domain_clean}"

    # 验证远程连接和目录
    detected_type = None
    detected_data_js = None
    detected_var_name = None
    detected_html_pattern = None
    try:
        checks = remote_publisher.verify_connection(site_path)
        if not checks.get("ssh_connected"):
            raise HTTPException(status_code=500, detail=f"无法连接宝塔服务器: {checks.get('error', '未知错误')}")
        if not checks.get("site_dir_exists"):
            logger.warning(f"宝塔服务器上目录不存在: {site_path}，请先在宝塔面板创建网站")
        # CR-037: 自动检测网站架构类型
        detected_type = checks.get("site_type")
        detected_data_js = checks.get("data_js_path")
        detected_var_name = checks.get("article_var_name")
        detected_html_pattern = checks.get("article_html_pattern")
        if detected_type:
            logger.info(f"自动检测 {domain_clean} 架构类型: {detected_type}")
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"远程验证跳过: {e}")

    group_id = data.group_id if (data.group_id and current_user.role in ("manager", "leader")) else current_user.team_id

    site = PubSite(
        group_id=group_id,
        site_name=data.site_name.strip(),
        site_path=site_path,
        domain=domain_clean,
        site_type=detected_type,
        data_js_path=detected_data_js or data.data_js_path,
        article_var_name=detected_var_name,
        article_html_pattern=detected_html_pattern,
        article_template=data.article_template,
        created_by=current_user.id,
        migrated=True,  # 宝塔方案不需要迁移
    )
    db.add(site)
    db.commit()
    db.refresh(site)

    return _site_to_dict(site, db)


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

    checks = remote_publisher.verify_connection(site.site_path)

    # CR-037: 如果检测到架构类型，自动更新
    detected_type = checks.get("site_type")
    if detected_type and detected_type != site.site_type:
        site.site_type = detected_type
        site.data_js_path = checks.get("data_js_path") or site.data_js_path
        site.article_var_name = checks.get("article_var_name")
        site.article_html_pattern = checks.get("article_html_pattern")
        db.commit()
        logger.info(f"已更新 {site.domain} 架构类型: {detected_type}")

    return {"site_id": site_id, "site_name": site.site_name, "checks": checks}
