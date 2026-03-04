"""
商家目录与任务分配 API
"""
import time
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
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
    return MerchantService.list_merchants(
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


@router.get("/stats")
async def merchant_stats(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return MerchantService.get_stats(db)


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


@router.post("/discover")
async def discover_merchants(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    trigger = "manual"
    count = MerchantService.discover_merchants(db, trigger_type=trigger)
    return {"message": f"发现并注册了 {count} 个新商家", "new_count": count}


# OPT-009: 手动触发平台商家同步（每 10 分钟限 1 次）
_last_sync_ts: float = 0.0

@router.post("/sync-platforms")
async def sync_platforms(
    current_user: User = Depends(get_current_manager),
    db: Session = Depends(get_db),
):
    global _last_sync_ts
    now = time.time()
    if now - _last_sync_ts < 600:
        remaining = int(600 - (now - _last_sync_ts))
        raise HTTPException(status_code=429, detail=f"同步冷却中，请 {remaining} 秒后再试")
    _last_sync_ts = now

    from app.services.merchant_platform_sync import MerchantPlatformSyncService
    svc = MerchantPlatformSyncService(db)
    return svc.sync_all()


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
    current_user: User = Depends(get_current_manager_or_leader),
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
