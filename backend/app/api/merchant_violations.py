"""
商家违规记录 API — Excel 上传、查询、员工分配检查
"""
import uuid
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user, get_current_manager_or_leader
from app.models.merchant import AffiliateMerchant, MerchantAssignment
from app.models.merchant_violation import MerchantViolation
from app.models.notification import Notification
from app.models.user import User

router = APIRouter(prefix="/api/merchant-violations", tags=["商家违规"])
logger = logging.getLogger(__name__)

PLATFORM_NAME_MAP = {
    "linkhaitao": "LH", "lh": "LH",
    "rewardoo": "RW", "rw": "RW",
    "collabglow": "CG", "cg": "CG",
    "brandsparkhub": "BSH", "bsh": "BSH",
    "partnermatic": "PM", "pm": "PM",
    "creatorflare": "CF", "cf": "CF",
    "linkbux": "LB", "lb": "LB",
}


def _normalize_platform(raw: str) -> str:
    if not raw:
        return raw
    return PLATFORM_NAME_MAP.get(raw.strip().lower(), raw.strip().upper())


@router.post("/upload")
async def upload_violations(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_manager_or_leader),
    db: Session = Depends(get_db),
):
    """上传违规商家 Excel，解析入库，标记违规商家，检查员工分配并发通知"""
    if not file.filename.endswith((".xlsx", ".xls")):
        raise HTTPException(status_code=400, detail="仅支持 .xlsx / .xls 文件")

    import openpyxl
    from io import BytesIO

    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="文件大小不能超过 10MB")

    try:
        wb = openpyxl.load_workbook(BytesIO(content), read_only=True)
        ws = wb[wb.sheetnames[0]]
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"无法读取 Excel: {e}")

    rows = list(ws.iter_rows(values_only=True))
    if len(rows) < 2:
        raise HTTPException(status_code=400, detail="Excel 无数据行")

    headers = [str(h or "").strip() for h in rows[0]]
    col = {}
    for i, h in enumerate(headers):
        hl = h.lower()
        if "mcid" in hl:
            col["mcid"] = i
        elif "violation" in hl and "time" in hl:
            col["violation_time"] = i
        elif "id" in hl and ("商家" in h or "merchant" in hl):
            col["merchant_mid"] = i
        elif "名称" in h or ("name" in hl and "merchant" in hl):
            col["merchant_name"] = i
        elif "平台" in h or "platform" in hl:
            col["platform"] = i
        elif "url" in hl:
            col["merchant_url"] = i

    if "merchant_name" not in col:
        raise HTTPException(status_code=400, detail="Excel 缺少商家名称列")

    batch_id = f"VIO-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:6]}"
    violations = []

    for row in rows[1:]:
        if not row or all(c is None for c in row):
            continue

        def _g(key, _row=row):
            idx = col.get(key)
            if idx is not None and idx < len(_row) and _row[idx] is not None:
                return str(_row[idx]).strip()
            return None

        merchant_name = _g("merchant_name")
        if not merchant_name:
            continue

        platform_raw = _g("platform")
        vt_raw = _g("violation_time")
        violation_time = None
        if vt_raw:
            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%Y/%m/%d %H:%M:%S"):
                try:
                    violation_time = datetime.strptime(vt_raw, fmt)
                    break
                except ValueError:
                    continue

        violations.append(MerchantViolation(
            mcid=_g("mcid"),
            merchant_mid=_g("merchant_mid"),
            merchant_name=merchant_name,
            platform=_normalize_platform(platform_raw) if platform_raw else "",
            merchant_url=_g("merchant_url"),
            violation_time=violation_time,
            upload_batch=batch_id,
        ))

    if not violations:
        raise HTTPException(status_code=400, detail="未解析到有效的违规记录")

    db.add_all(violations)
    db.flush()

    # 标记 affiliate_merchants + 检查员工分配
    marked_count = 0
    alert_assignments = []

    for v in violations:
        conditions = []
        if v.merchant_mid and v.merchant_mid.isdigit():
            conditions.append(
                (AffiliateMerchant.merchant_id == v.merchant_mid)
                & (AffiliateMerchant.platform == v.platform)
            )
        if v.mcid:
            conditions.append(
                (func.lower(AffiliateMerchant.slug) == v.mcid.lower())
                & (AffiliateMerchant.platform == v.platform)
            )
        conditions.append(
            (func.lower(AffiliateMerchant.merchant_name) == v.merchant_name.lower())
            & (AffiliateMerchant.platform == v.platform)
        )

        matched = db.query(AffiliateMerchant).filter(or_(*conditions)).all()
        for m in matched:
            if m.violation_status != "violated":
                m.violation_status = "violated"
                m.violation_time = v.violation_time or datetime.utcnow()
                marked_count += 1

            actives = (
                db.query(MerchantAssignment)
                .filter(MerchantAssignment.merchant_id == m.id, MerchantAssignment.status == "active")
                .all()
            )
            for a in actives:
                user = db.query(User).get(a.user_id)
                if user:
                    alert_assignments.append({
                        "merchant_name": m.merchant_name,
                        "platform": m.platform,
                        "user_id": a.user_id,
                        "user_display_name": user.display_name or user.username,
                    })

    # 发通知
    notified_users = set()
    if alert_assignments:
        user_alerts = {}
        for a in alert_assignments:
            user_alerts.setdefault(a["user_id"], []).append(f"{a['merchant_name']}({a['platform']})")

        for uid, mlist in user_alerts.items():
            s = "、".join(mlist[:5])
            if len(mlist) > 5:
                s += f" 等{len(mlist)}个"
            db.add(Notification(user_id=uid, type="violation_alert",
                                title="违规商家告警",
                                content=f"你分配的以下商家已被标记为违规：{s}。请及时处理。"))
            notified_users.add(uid)

        managers = db.query(User).filter(User.role.in_(["admin", "manager"])).all()
        affected_names = list({a["user_display_name"] for a in alert_assignments})
        emp_str = "、".join(affected_names[:5])
        if len(affected_names) > 5:
            emp_str += f" 等{len(affected_names)}人"
        for mgr in managers:
            if mgr.id not in notified_users:
                db.add(Notification(
                    user_id=mgr.id, type="violation_alert",
                    title="违规商家上传告警",
                    content=f"本次上传 {len(violations)} 条违规记录，标记 {marked_count} 个商家，"
                            f"涉及员工：{emp_str}（共 {len(alert_assignments)} 条分配）。",
                ))

    db.commit()
    return {
        "success": True, "batch_id": batch_id,
        "total_records": len(violations), "marked_merchants": marked_count,
        "affected_assignments": len(alert_assignments),
        "notified_users": len(notified_users),
        "alert_details": alert_assignments[:20],
    }


@router.get("")
async def list_violations(
    platform: Optional[str] = None,
    batch_id: Optional[str] = None,
    search: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """查询违规商家列表"""
    q = db.query(MerchantViolation)
    if platform:
        q = q.filter(MerchantViolation.platform == _normalize_platform(platform))
    if batch_id:
        q = q.filter(MerchantViolation.upload_batch == batch_id)
    if search:
        like = f"%{search}%"
        q = q.filter(or_(
            MerchantViolation.merchant_name.ilike(like),
            MerchantViolation.mcid.ilike(like),
            MerchantViolation.merchant_mid.ilike(like),
        ))

    total = q.count()
    items = (
        q.order_by(MerchantViolation.violation_time.desc().nullslast(), MerchantViolation.id.desc())
        .offset((page - 1) * page_size).limit(page_size).all()
    )
    return {
        "total": total, "page": page, "page_size": page_size,
        "items": [{
            "id": v.id, "mcid": v.mcid, "merchant_mid": v.merchant_mid,
            "merchant_name": v.merchant_name, "platform": v.platform,
            "merchant_url": v.merchant_url,
            "violation_time": v.violation_time.isoformat() if v.violation_time else None,
            "upload_batch": v.upload_batch,
            "created_at": v.created_at.isoformat() if v.created_at else None,
        } for v in items],
    }


@router.get("/check-assignments")
async def check_violation_assignments(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """检查哪些员工分配了违规商家"""
    violated = (
        db.query(AffiliateMerchant)
        .filter(AffiliateMerchant.violation_status == "violated")
        .all()
    )
    if not violated:
        return {"total_violated": 0, "affected_assignments": []}

    results = []
    for m in violated:
        actives = (
            db.query(MerchantAssignment)
            .filter(MerchantAssignment.merchant_id == m.id, MerchantAssignment.status == "active")
            .all()
        )
        for a in actives:
            user = db.query(User).get(a.user_id)
            results.append({
                "merchant_name": m.merchant_name, "merchant_id": m.merchant_id,
                "platform": m.platform,
                "violation_time": m.violation_time.isoformat() if m.violation_time else None,
                "user_id": a.user_id,
                "user_display_name": user.display_name if user else None,
                "assigned_at": a.assigned_at.isoformat() if a.assigned_at else None,
            })
    return {"total_violated": len(violated), "affected_assignments": results}


@router.get("/batches")
async def list_batches(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """查询所有上传批次"""
    batches = (
        db.query(
            MerchantViolation.upload_batch,
            func.count(MerchantViolation.id).label("count"),
            func.min(MerchantViolation.created_at).label("uploaded_at"),
        )
        .group_by(MerchantViolation.upload_batch)
        .order_by(func.min(MerchantViolation.created_at).desc())
        .all()
    )
    return [{
        "batch_id": b.upload_batch, "count": b.count,
        "uploaded_at": b.uploaded_at.isoformat() if b.uploaded_at else None,
    } for b in batches]
