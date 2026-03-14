"""
商家目录与任务分配 API
"""
import json
import os
import time
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user, get_current_manager, get_current_manager_or_leader
from app.models.user import User
from app.schemas.merchant import MerchantUpdate, AssignmentCreate, AssignmentUpdate, AssignmentTransfer
from app.services.merchant_service import MerchantService

router = APIRouter(prefix="/api/merchants", tags=["商家管理"])
assignment_router = APIRouter(prefix="/api/merchant-assignments", tags=["商家分配"])
performance_router = APIRouter(prefix="/api/merchant-performance", tags=["商家绩效"])


# ==================================================================
# 商家目录
# ==================================================================

@router.get("")
async def list_merchants(
    platform: Optional[str] = None,
    category: Optional[str] = None,
    status: Optional[str] = None,
    assigned: Optional[bool] = None,
    missing_mid: Optional[bool] = None,
    relationship_status: Optional[str] = None,
    search: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    sd = date.fromisoformat(start_date) if start_date else None
    ed = date.fromisoformat(end_date) if end_date else None
    # region agent log
    import json as _json, time as _time, pathlib as _pl
    try:
        result = MerchantService.list_merchants(
            db,
            platform=platform,
            category=category,
            status=status,
            assigned=assigned,
            missing_mid=missing_mid,
            relationship_status=relationship_status,
            search=search,
            start_date=sd,
            end_date=ed,
            page=page,
            page_size=page_size,
        )
        _pl.Path("debug-6b95b2.log").open("a").write(_json.dumps({"sessionId":"6b95b2","location":"merchants.py:list_merchants:ok","message":"list ok","data":{"page":page,"total":result.get("total",0)},"timestamp":_time.time()*1000,"hypothesisId":"H1,H4"})+"\n")
        return result
    except Exception as _exc:
        _pl.Path("debug-6b95b2.log").open("a").write(_json.dumps({"sessionId":"6b95b2","location":"merchants.py:list_merchants:error","message":"list error","data":{"error":str(_exc),"type":type(_exc).__name__},"timestamp":_time.time()*1000,"hypothesisId":"H1,H4"})+"\n")
        raise
    # endregion


@router.get("/stats")
async def merchant_stats(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return MerchantService.get_stats(db, user_id=current_user.id)


# ==================================================================
# 广告创建默认设置 (must be before /{merchant_pk} catch-all routes)
# ==================================================================

AD_DEFAULTS_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "ad_defaults.json")

DEFAULT_AD_SETTINGS = {
    "bidding_strategy": "MANUAL_CPC",
    "enhanced_cpc": False,
    "target_google_search": True,
    "target_search_network": False,
    "target_content_network": False,
    "default_cpc_bid": 1.0,
    "default_daily_budget": 10,
    "geo_target_type": "PRESENCE",
    "eu_political_ads": False,
}


def _load_ad_defaults() -> dict:
    if os.path.exists(AD_DEFAULTS_FILE):
        try:
            with open(AD_DEFAULTS_FILE, "r") as f:
                return {**DEFAULT_AD_SETTINGS, **json.load(f)}
        except Exception:
            pass
    return dict(DEFAULT_AD_SETTINGS)


def _save_ad_defaults(data: dict):
    with open(AD_DEFAULTS_FILE, "w") as f:
        json.dump(data, f, indent=2)


class AdDefaultsUpdate(BaseModel):
    bidding_strategy: Optional[str] = None
    enhanced_cpc: Optional[bool] = None
    target_google_search: Optional[bool] = None
    target_search_network: Optional[bool] = None
    target_content_network: Optional[bool] = None
    default_cpc_bid: Optional[float] = None
    default_daily_budget: Optional[float] = None
    geo_target_type: Optional[str] = None
    eu_political_ads: Optional[bool] = None


@router.get("/ad-defaults")
async def get_ad_defaults():
    return _load_ad_defaults()


@router.put("/ad-defaults")
async def update_ad_defaults(
    data: AdDefaultsUpdate,
    current_user: User = Depends(get_current_user),
):
    incoming = {k: v for k, v in data.dict().items() if v is not None}
    settings = {**DEFAULT_AD_SETTINGS, **incoming}
    _save_ad_defaults(settings)
    return {"message": "广告默认设置已保存", **settings}


@router.get("/{merchant_pk}")
async def get_merchant(
    merchant_pk: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    result = MerchantService.get_merchant(db, merchant_pk)
    if not result:
        raise HTTPException(status_code=404, detail="商家不存在")
    return result


@router.put("/{merchant_pk}")
async def update_merchant(
    merchant_pk: int,
    data: MerchantUpdate,
    current_user: User = Depends(get_current_manager_or_leader),
    db: Session = Depends(get_db),
):
    try:
        m = MerchantService.update_merchant(db, merchant_pk, data.model_dump(exclude_unset=True))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if not m:
        raise HTTPException(status_code=404, detail="商家不存在")
    return {"message": "更新成功"}


@router.get("/{merchant_pk}/campaign-detail")
async def get_merchant_campaign_detail(
    merchant_pk: int,
    user_id: Optional[int] = Query(None, description="目标员工ID，用于获取该员工的追踪链接"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """从 campaign_link_cache 获取商家详情（追踪链接、区域、佣金率等）"""
    from app.models.merchant import AffiliateMerchant
    from app.models.campaign_link_cache import CampaignLinkCache
    from app.models.merchant_recommendation import MerchantRecommendation
    import json

    merchant = db.query(AffiliateMerchant).get(merchant_pk)
    if not merchant:
        raise HTTPException(status_code=404, detail="商家不存在")

    mid = merchant.merchant_id
    platform_map = {
        "CG": "CG", "RW": "RW", "LH": "LH", "LB": "LB",
        "PM": "PM", "BSH": "BSH", "CF": "CF",
    }
    platform_code = platform_map.get(merchant.platform, merchant.platform)

    # 优先查目标员工的缓存，fallback 任意缓存
    cache = None
    if user_id and mid:
        cache = db.query(CampaignLinkCache).filter(
            CampaignLinkCache.user_id == user_id,
            CampaignLinkCache.platform_code == platform_code,
            CampaignLinkCache.merchant_id == mid,
        ).first()
    if not cache and mid:
        cache = db.query(CampaignLinkCache).filter(
            CampaignLinkCache.platform_code == platform_code,
            CampaignLinkCache.merchant_id == mid,
        ).first()

    # 查推荐数据
    recommend = None
    if mid:
        recommend = db.query(MerchantRecommendation).filter(
            MerchantRecommendation.merchant_mid == mid
        ).order_by(MerchantRecommendation.id.desc()).first()
    if not recommend and merchant.slug:
        recommend = db.query(MerchantRecommendation).filter(
            MerchantRecommendation.mcid == merchant.slug
        ).order_by(MerchantRecommendation.id.desc()).first()

    result = {
        "merchant_id": mid,
        "merchant_name": merchant.merchant_name,
        "platform": merchant.platform,
    }

    if cache:
        regions = []
        if cache.support_regions:
            try:
                regions = json.loads(cache.support_regions)
            except (json.JSONDecodeError, TypeError):
                regions = []
        result.update({
            "campaign_link": cache.campaign_link,
            "site_url": cache.site_url,
            "support_regions": regions,
            "categories": cache.categories,
            "commission_rate": cache.commission_rate,
            "cache_found": True,
        })
    else:
        result["cache_found"] = False

    if recommend:
        result["recommendation"] = {
            "epc": float(recommend.epc) if recommend.epc else None,
            "commission_cap": float(recommend.commission_cap) if recommend.commission_cap else None,
            "avg_commission_rate": float(recommend.avg_commission_rate) if recommend.avg_commission_rate else None,
            "avg_order_commission": float(recommend.avg_order_commission) if recommend.avg_order_commission else None,
            "merchant_region": recommend.merchant_region,
        }

    return result


@router.post("/discover")
async def discover_merchants(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    trigger = "manual"
    count = MerchantService.discover_merchants(db, trigger_type=trigger)
    return {"message": f"发现并注册了 {count} 个新商家", "new_count": count}


@router.post("/repair-lh-mid")
async def repair_lh_mid(
    current_user: User = Depends(get_current_manager),
    db: Session = Depends(get_db),
):
    """一键补齐所有 LH 平台的纯数字 MID"""
    result = MerchantService.repair_all_lh_mid(db)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("message", "补齐失败"))
    return result


_mid_repair_running: bool = False
_mid_repair_result: Optional[dict] = None


def _run_mid_repair_background():
    """后台运行全平台MID补齐：sync_all + repair_lh_mid + auto_repair_mid"""
    global _mid_repair_running, _mid_repair_result
    import logging
    logger = logging.getLogger(__name__)
    results = {}
    try:
        from app.database import SessionLocal
        from app.services.merchant_platform_sync import MerchantPlatformSyncService
        db = SessionLocal()
        try:
            svc = MerchantPlatformSyncService(db)
            results["sync"] = svc.sync_all()
            logger.info("[MID Repair] sync_all done")
        except Exception as e:
            results["sync_error"] = str(e)
            logger.exception("[MID Repair] sync_all failed")
        try:
            results["lh_repair"] = MerchantService.repair_all_lh_mid(db)
            logger.info("[MID Repair] LH repair done")
        except Exception as e:
            results["lh_repair_error"] = str(e)
            logger.exception("[MID Repair] LH repair failed")
        try:
            results["auto_repair"] = MerchantService.auto_repair_mid(db)
            logger.info("[MID Repair] auto_repair done")
        except Exception as e:
            results["auto_repair_error"] = str(e)
            logger.exception("[MID Repair] auto_repair failed")
        db.close()
    except Exception as exc:
        results["fatal_error"] = str(exc)
    finally:
        _mid_repair_result = results
        _mid_repair_running = False


@router.post("/repair-all-mid")
async def repair_all_mid(
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
):
    """一键补齐所有平台MID（后台运行）"""
    global _mid_repair_running, _mid_repair_result
    if _mid_repair_running:
        raise HTTPException(status_code=429, detail="MID补齐正在进行中，请稍后查看结果")
    _mid_repair_running = True
    _mid_repair_result = None
    background_tasks.add_task(_run_mid_repair_background)
    return {"status": "started", "message": "MID补齐已在后台启动，预计需要5-10分钟"}


@router.get("/repair-all-mid/status")
async def repair_all_mid_status(
    current_user: User = Depends(get_current_user),
):
    """查询MID补齐进度"""
    if _mid_repair_running:
        return {"status": "running", "message": "MID补齐正在进行中..."}
    if _mid_repair_result is not None:
        return {"status": "done", "result": _mid_repair_result}
    return {"status": "idle", "message": "无正在进行的MID补齐任务"}


# OPT-009: 手动触发平台商家同步（每 10 分钟限 1 次，后台运行）
_last_sync_ts: float = 0.0
_sync_running: bool = False
_sync_result: Optional[dict] = None


def _run_sync_background():
    """在后台线程执行商家同步。"""
    global _sync_running, _sync_result
    import logging
    logger = logging.getLogger(__name__)
    try:
        from app.database import SessionLocal
        from app.services.merchant_platform_sync import MerchantPlatformSyncService
        db = SessionLocal()
        try:
            svc = MerchantPlatformSyncService(db)
            _sync_result = svc.sync_all()
            logger.info("[MerchantSync] background sync done: %s", _sync_result)
        finally:
            db.close()
    except Exception as exc:
        logger.exception("[MerchantSync] background sync failed")
        _sync_result = {"error": str(exc)}
    finally:
        _sync_running = False


@router.post("/sync-platforms")
async def sync_platforms(
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_manager),
):
    global _last_sync_ts, _sync_running
    if _sync_running:
        raise HTTPException(status_code=429, detail="同步正在进行中，请稍后查看结果")

    now = time.time()
    if now - _last_sync_ts < 600:
        remaining = int(600 - (now - _last_sync_ts))
        raise HTTPException(status_code=429, detail=f"同步冷却中，请 {remaining} 秒后再试")
    _last_sync_ts = now
    _sync_running = True

    background_tasks.add_task(_run_sync_background)
    return {"message": "同步已在后台启动，预计需要 3-5 分钟完成", "status": "started"}


@router.get("/sync-platforms/status")
async def sync_platforms_status(
    current_user: User = Depends(get_current_manager),
):
    if _sync_running:
        return {"status": "running", "message": "同步正在进行中..."}
    if _sync_result is not None:
        return {"status": "done", **_sync_result}
    return {"status": "idle", "message": "没有正在进行的同步"}


@router.get("/{merchant_pk}/active-advertisers")
async def get_active_advertisers(
    merchant_pk: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """获取某商家近30天内在投广告的员工列表"""
    return MerchantService.get_active_advertisers(db, merchant_pk)


# OPT-009: 商家佣金拆分明细
@router.get("/{merchant_pk}/commission-breakdown")
async def commission_breakdown(
    merchant_pk: int,
    start_date: str = Query(..., description="YYYY-MM-DD"),
    end_date: str = Query(..., description="YYYY-MM-DD"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    sd = date.fromisoformat(start_date)
    ed = date.fromisoformat(end_date)
    result = MerchantService.get_commission_breakdown(
        db, merchant_pk, sd, ed, current_user=current_user,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="商家不存在")
    return result


# ==================================================================
# 任务分配
# ==================================================================


class ClaimRequest(BaseModel):
    merchant_ids: list
    mode: str = "normal"  # normal / test
    target_country: str = "US"


@assignment_router.post("/claim")
async def claim_merchants(
    data: ClaimRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """CR-039: 员工自助领取商家（所有登录用户可调用）"""
    from app.models.merchant import MerchantAssignment, AffiliateMerchant
    created = []
    merchant_names = {}
    skipped = 0
    skipped_assignments = []
    for mid in data.merchant_ids:
        merchant = db.query(AffiliateMerchant).filter(AffiliateMerchant.id == mid).first()
        if not merchant:
            continue
        existing = db.query(MerchantAssignment).filter(
            MerchantAssignment.merchant_id == mid,
            MerchantAssignment.user_id == current_user.id,
            MerchantAssignment.status == "active",
        ).first()
        if existing:
            skipped += 1
            skipped_assignments.append({
                "id": existing.id,
                "merchant_id": existing.merchant_id,
                "merchant_name": merchant.merchant_name,
            })
            continue
        assignment = MerchantAssignment(
            merchant_id=mid,
            user_id=current_user.id,
            assigned_by=current_user.id,
            status="active",
            mode=data.mode,
            target_country=data.target_country,
            assignment_source="self_claim",
        )
        db.add(assignment)
        created.append(assignment)
        merchant_names[mid] = merchant.merchant_name
    db.commit()
    for a in created:
        db.refresh(a)
    return {
        "message": f"成功领取 {len(created)} 个商家" + (f"，{skipped} 个已领取" if skipped else ""),
        "count": len(created),
        "skipped": skipped,
        "assignments": [
            {"id": a.id, "merchant_id": a.merchant_id, "merchant_name": merchant_names.get(a.merchant_id, "")}
            for a in created
        ],
        "skipped_assignments": skipped_assignments,
    }


@assignment_router.post("")
async def create_assignments(
    data: AssignmentCreate,
    current_user: User = Depends(get_current_manager_or_leader),
    db: Session = Depends(get_db),
):
    try:
        created = MerchantService.assign_merchants(
            db,
            merchant_ids=data.merchant_ids,
            user_id=data.user_id,
            assigned_by=current_user.id,
            priority=data.priority,
            monthly_target=data.monthly_target,
            notes=data.notes,
        )
        return {"message": f"成功分配 {len(created)} 个商家", "count": len(created)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@assignment_router.get("")
async def list_assignments(
    user_id: Optional[int] = None,
    status: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return MerchantService.list_assignments(
        db,
        user=current_user,
        user_id=user_id,
        status=status,
        page=page,
        page_size=page_size,
    )


@assignment_router.put("/{assignment_id}")
async def update_assignment(
    assignment_id: int,
    data: AssignmentUpdate,
    current_user: User = Depends(get_current_manager_or_leader),
    db: Session = Depends(get_db),
):
    a = MerchantService.update_assignment(db, assignment_id, data.model_dump(exclude_unset=True))
    if not a:
        raise HTTPException(status_code=404, detail="分配记录不存在")
    return {"message": "更新成功"}


@assignment_router.delete("/{assignment_id}")
async def delete_assignment(
    assignment_id: int,
    current_user: User = Depends(get_current_manager_or_leader),
    db: Session = Depends(get_db),
):
    ok = MerchantService.delete_assignment(db, assignment_id)
    if not ok:
        raise HTTPException(status_code=404, detail="分配记录不存在")
    return {"message": "已取消分配"}


@assignment_router.post("/transfer")
async def transfer_assignments(
    data: AssignmentTransfer,
    current_user: User = Depends(get_current_manager),
    db: Session = Depends(get_db),
):
    try:
        count = MerchantService.transfer_assignments(
            db,
            assignment_ids=data.assignment_ids,
            new_user_id=data.new_user_id,
            transferred_by=current_user.id,
        )
        return {"message": f"成功转移 {count} 个分配", "count": count}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ==================================================================
# 绩效看板
# ==================================================================

@performance_router.get("")
async def get_performance(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    user_id: Optional[int] = None,
    platform: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    sd = datetime.fromisoformat(start_date) if start_date else None
    ed = datetime.fromisoformat(end_date) if end_date else None
    return MerchantService.get_performance(
        db, start_date=sd, end_date=ed, user_id=user_id, platform=platform, user=current_user,
    )


@performance_router.get("/ranking")
async def get_ranking(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    sd = datetime.fromisoformat(start_date) if start_date else None
    ed = datetime.fromisoformat(end_date) if end_date else None
    return MerchantService.get_ranking(db, start_date=sd, end_date=ed, user=current_user)


# ==================================================================
# P2: 审计事件查询
# ==================================================================

@assignment_router.get("/{assignment_id}/events")
async def get_assignment_events(
    assignment_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """查询分配审计事件链"""
    from app.models.merchant_assignment_event import MerchantAssignmentEvent
    from app.models.user import User as UserModel

    events = (
        db.query(MerchantAssignmentEvent)
        .filter(MerchantAssignmentEvent.assignment_id == assignment_id)
        .order_by(MerchantAssignmentEvent.created_at.asc())
        .all()
    )
    result = []
    for e in events:
        operator = db.query(UserModel).get(e.operator_id) if e.operator_id else None
        result.append({
            "id": e.id,
            "assignment_id": e.assignment_id,
            "event_type": e.event_type,
            "old_value": e.old_value,
            "new_value": e.new_value,
            "operator_id": e.operator_id,
            "operator_name": operator.display_name if operator else None,
            "created_at": e.created_at.isoformat() if e.created_at else None,
        })
    return {"assignment_id": assignment_id, "events": result}
