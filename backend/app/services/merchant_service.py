"""
商家目录与任务分配服务
"""
import logging
from datetime import datetime, date, timedelta, timezone
from typing import Optional

from sqlalchemy import func, case, and_, or_, distinct
from sqlalchemy.orm import Session, joinedload

from app.models.merchant import AffiliateMerchant, MerchantAssignment
from app.models.merchant_discovery_run import MerchantDiscoveryRun
from app.models.merchant_mid_repair_queue import MerchantMidRepairQueue
from app.models.merchant_alias import MerchantAlias
from app.models.merchant_assignment_event import MerchantAssignmentEvent
from app.models.affiliate_transaction import AffiliateTransaction
from app.models.google_ads_api_data import GoogleAdsApiData
from app.models.user import User
from app.models.notification import Notification

logger = logging.getLogger(__name__)


class MerchantService:

    PLATFORM_NORM = {
        "pm": "PM", "pm1": "PM", "pm2": "PM", "pm3": "PM",
        "cg": "CG", "cg1": "CG", "cg2": "CG", "cg3": "CG",
        "rw": "RW", "rw1": "RW", "rw2": "RW", "rw3": "RW",
        "lh": "LH", "lh1": "LH", "lh2": "LH", "lh3": "LH",
        "lb": "LB", "lb1": "LB", "lb2": "LB", "lb3": "LB",
        "ls": "LS", "ls1": "LS", "ls2": "LS", "ls3": "LS",
        "bsh": "BSH", "bsh1": "BSH", "bsh2": "BSH",
        "cf": "CF", "cf1": "CF", "cf2": "CF",
        "ui": "UI", "ui1": "UI", "ui2": "UI",
    }
    URL_PLATFORM = {
        "brandsparkhub.com": "BSH",
        "collabglow.com": "CG",
        "rewardoo.com": "RW",
        "linkhaitao.com": "LH",
        "linkbux.com": "LB",
        "partnermatic.com": "PM",
        "creatorflare.com": "CF",
    }

    @staticmethod
    def normalize_platform(raw: str) -> str:
        if not raw:
            return raw
        s = raw.strip()
        low = s.lower()
        if low in MerchantService.PLATFORM_NORM:
            return MerchantService.PLATFORM_NORM[low]
        if "://" in s or "." in s:
            domain = low.replace("https://", "").replace("http://", "").rstrip("/").lstrip("www.")
            for url_key, code in MerchantService.URL_PLATFORM.items():
                if url_key in domain:
                    return code
        return s.upper() if s.isalpha() and len(s) <= 5 else s

    # ------------------------------------------------------------------
    # 商家自动发现
    # ------------------------------------------------------------------

    @staticmethod
    def discover_merchants(db: Session, trigger_type: str = "scheduler") -> int:
        """扫描 affiliate_transactions 发现并注册新商家，返回新增数量。
        同时写入 merchant_discovery_runs 日志和 merchant_mid_repair_queue 补偿条目。
        """
        run_date = date.today()
        run = MerchantDiscoveryRun(run_date=run_date, trigger_type=trigger_type, status="running")
        db.add(run)
        db.flush()

        try:
            total_tx = db.query(func.count(AffiliateTransaction.id)).scalar() or 0
            tx_with_mid = (
                db.query(func.count(AffiliateTransaction.id))
                .filter(
                    AffiliateTransaction.merchant_id.isnot(None),
                    AffiliateTransaction.merchant_id != "",
                )
                .scalar() or 0
            )
            tx_missing_mid = total_tx - tx_with_mid

            existing = set(
                (MerchantService.normalize_platform(p), mid)
                for p, mid in db.query(AffiliateMerchant.platform, AffiliateMerchant.merchant_id)
                .filter(AffiliateMerchant.merchant_id.isnot(None))
                .all()
            )

            new_merchants = (
                db.query(
                    AffiliateTransaction.platform,
                    AffiliateTransaction.merchant_id,
                    func.max(AffiliateTransaction.merchant).label("merchant_name"),
                )
                .filter(
                    AffiliateTransaction.merchant_id.isnot(None),
                    AffiliateTransaction.merchant_id != "",
                )
                .group_by(AffiliateTransaction.platform, AffiliateTransaction.merchant_id)
                .all()
            )

            count = 0
            for row in new_merchants:
                norm_plat = MerchantService.normalize_platform(row.platform)
                key = (norm_plat, row.merchant_id)
                if key in existing:
                    continue

                name = row.merchant_name or row.merchant_id
                normalized = MerchantService._normalize_merchant_name(name)

                # P1: 别名去重——查 merchant_aliases 是否已映射到已有商家
                alias_match = (
                    db.query(MerchantAlias)
                    .filter(
                        MerchantAlias.platform.in_([row.platform, norm_plat]),
                        MerchantAlias.normalized_name == normalized,
                    )
                    .first()
                )
                if alias_match and alias_match.merchant_id_ref:
                    existing.add(key)
                    continue

                merchant = AffiliateMerchant(
                    platform=MerchantService.normalize_platform(row.platform),
                    merchant_id=row.merchant_id,
                    merchant_name=name,
                    missing_mid=0,
                    id_confidence="high",
                    source_type="transaction",
                )
                db.add(merchant)
                db.flush()

                # 自动创建别名记录（M-018-B / ML-03：使用归一化后的平台代码）
                existing_alias = db.query(MerchantAlias.id).filter(
                    MerchantAlias.platform == norm_plat,
                    MerchantAlias.alias_name == name,
                ).first()
                if not existing_alias:
                    db.add(MerchantAlias(
                        platform=norm_plat,
                        alias_name=name,
                        normalized_name=normalized,
                        merchant_id_ref=merchant.id,
                        source="auto",
                    ))
                count += 1

            missing_mid_rows = (
                db.query(
                    AffiliateTransaction.platform,
                    AffiliateTransaction.merchant.label("merchant_name_raw"),
                    func.max(AffiliateTransaction.transaction_time).label("latest_tx"),
                )
                .filter(
                    or_(
                        AffiliateTransaction.merchant_id.is_(None),
                        AffiliateTransaction.merchant_id == "",
                    )
                )
                .group_by(AffiliateTransaction.platform, AffiliateTransaction.merchant)
                .all()
            )

            missing_mid_count = 0
            new_repair_count = 0
            for row in missing_mid_rows:
                merchant_name = (row.merchant_name_raw or "").strip()
                if not merchant_name:
                    continue

                norm_plat_missing = MerchantService.normalize_platform(row.platform)

                exists_missing = db.query(AffiliateMerchant.id).filter(
                    AffiliateMerchant.platform == norm_plat_missing,
                    AffiliateMerchant.merchant_name == merchant_name,
                    AffiliateMerchant.missing_mid == 1,
                ).first()
                if not exists_missing:
                    merchant = AffiliateMerchant(
                        platform=norm_plat_missing,
                        merchant_id=None,
                        merchant_name=merchant_name,
                        missing_mid=1,
                        id_confidence="low",
                        source_type="transaction",
                        notes="自动发现：交易存在但MID缺失，待补偿",
                    )
                    db.add(merchant)
                    missing_mid_count += 1

                # G-07: 生成 merchant_mid_repair_queue 补偿条目
                existing_repair = db.query(MerchantMidRepairQueue.id).filter(
                    MerchantMidRepairQueue.platform == norm_plat_missing,
                    MerchantMidRepairQueue.merchant_name == merchant_name,
                    MerchantMidRepairQueue.repair_status.in_(["pending", "retrying"]),
                ).first()
                if not existing_repair:
                    candidate = MerchantService._find_candidate_mid(db, norm_plat_missing, merchant_name)
                    repair = MerchantMidRepairQueue(
                        platform=norm_plat_missing,
                        merchant_name=merchant_name,
                        latest_tx_time=row.latest_tx,
                        candidate_mid=candidate,
                        repair_status="pending",
                        confidence_score=1.0 if candidate else None,
                    )
                    db.add(repair)
                    new_repair_count += 1

            run.total_tx = total_tx
            run.tx_with_mid = tx_with_mid
            run.tx_missing_mid = tx_missing_mid
            run.new_merchant_count = count
            run.new_missing_mid_count = missing_mid_count
            run.status = "success"

            # 从 GoogleAdsApiData 发现缺失商家
            ads_new = 0
            try:
                ad_merchants = (
                    db.query(
                        func.rtrim(func.lower(GoogleAdsApiData.extracted_platform_code), '0123456789').label("platform"),
                        GoogleAdsApiData.extracted_account_code.label("mid"),
                        func.max(GoogleAdsApiData.campaign_name).label("campaign_name"),
                    )
                    .filter(
                        GoogleAdsApiData.extracted_account_code.isnot(None),
                        GoogleAdsApiData.extracted_account_code != "",
                    )
                    .group_by(
                        func.rtrim(func.lower(GoogleAdsApiData.extracted_platform_code), '0123456789'),
                        GoogleAdsApiData.extracted_account_code,
                    )
                    .all()
                )
                existing_refresh = set(
                    (MerchantService.normalize_platform(p).lower(), mid)
                    for p, mid in db.query(AffiliateMerchant.platform, AffiliateMerchant.merchant_id)
                    .filter(AffiliateMerchant.merchant_id.isnot(None))
                    .all()
                )
                for row in ad_merchants:
                    norm_p = MerchantService.normalize_platform(row.platform)
                    if (norm_p.lower(), row.mid) in existing_refresh:
                        continue
                    name = row.mid
                    if row.campaign_name:
                        parts = row.campaign_name.split("-")
                        if len(parts) >= 3:
                            name = parts[2].strip() or row.mid
                    db.add(AffiliateMerchant(
                        platform=norm_p,
                        merchant_id=row.mid,
                        merchant_name=name,
                        missing_mid=0,
                        id_confidence="medium",
                        source_type="ads_data",
                    ))
                    existing_refresh.add((norm_p.lower(), row.mid))
                    ads_new += 1
                if ads_new:
                    db.commit()
                    logger.info("[商家发现] 从广告数据新增 %d 个商家", ads_new)
            except Exception as ads_err:
                logger.warning("[商家发现] 广告数据发现失败: %s", ads_err)
                db.rollback()

            if count or missing_mid_count or new_repair_count:
                db.commit()
                logger.info(
                    "[商家发现] 新增 %d 个商家，%d 条待补MID记录，%d 条补偿队列",
                    count, missing_mid_count, new_repair_count,
                )
            else:
                db.commit()
        except Exception as e:
            run.status = "failed"
            run.error_message = str(e)[:500]
            db.commit()
            raise

        return count + ads_new

    @staticmethod
    def _find_candidate_mid(db: Session, platform: str, merchant_name: str) -> Optional[str]:
        """在同平台商家中查找同名的唯一数字 MID 作为候选"""
        matches = (
            db.query(AffiliateMerchant.merchant_id)
            .filter(
                AffiliateMerchant.platform == platform,
                AffiliateMerchant.merchant_name == merchant_name,
                AffiliateMerchant.merchant_id.isnot(None),
                AffiliateMerchant.merchant_id != "",
                AffiliateMerchant.missing_mid == 0,
            )
            .distinct()
            .all()
        )
        mids = [r[0] for r in matches if r[0] and r[0].strip().isdigit()]
        return mids[0] if len(mids) == 1 else None

    @staticmethod
    def auto_repair_mid(db: Session) -> dict:
        """自动补偿 MID：按平台+商家名反查唯一数字 MID 进行回填。
        返回 {repaired: int, failed: int, missing_rate_by_platform: dict}
        """
        pending_items = (
            db.query(MerchantMidRepairQueue)
            .filter(
                MerchantMidRepairQueue.repair_status.in_(["pending", "retrying"]),
            )
            .all()
        )

        repaired = 0
        failed = 0
        now = datetime.now(timezone.utc)

        for item in pending_items:
            candidate = MerchantService._find_candidate_mid(db, item.platform, item.merchant_name)
            item.attempts += 1

            if candidate:
                # 回填 AffiliateMerchant
                missing_merchant = (
                    db.query(AffiliateMerchant)
                    .filter(
                        AffiliateMerchant.platform == item.platform,
                        AffiliateMerchant.merchant_name == item.merchant_name,
                        AffiliateMerchant.missing_mid == 1,
                    )
                    .first()
                )
                if missing_merchant:
                    missing_merchant.merchant_id = candidate
                    missing_merchant.missing_mid = 0
                    missing_merchant.id_confidence = "medium"

                item.resolved_mid = candidate
                item.repair_status = "resolved"
                item.resolved_at = now
                item.confidence_score = 1.0
                item.reason = "同平台同商家名唯一MID自动回填"
                repaired += 1
            else:
                item.repair_status = "retrying" if item.attempts < 3 else "failed"
                item.next_retry_at = now + timedelta(days=1) if item.attempts < 3 else None
                item.reason = "未找到唯一匹配MID" if not candidate else None
                failed += 1

        db.commit()

        # 计算各平台 MID 缺失率
        platform_stats = (
            db.query(
                AffiliateTransaction.platform,
                func.count(AffiliateTransaction.id).label("total"),
                func.sum(
                    case(
                        (or_(
                            AffiliateTransaction.merchant_id.is_(None),
                            AffiliateTransaction.merchant_id == "",
                        ), 1),
                        else_=0,
                    )
                ).label("missing"),
            )
            .group_by(AffiliateTransaction.platform)
            .all()
        )

        missing_rate_by_platform = {}
        for row in platform_stats:
            total = row.total or 0
            missing = row.missing or 0
            rate = round((missing / total * 100), 2) if total > 0 else 0.0
            missing_rate_by_platform[row.platform] = {
                "total": total,
                "missing": missing,
                "rate": rate,
            }

        logger.info("[MID自动补偿] 修复 %d 条，失败 %d 条", repaired, failed)
        return {
            "repaired": repaired,
            "failed": failed,
            "missing_rate_by_platform": missing_rate_by_platform,
        }

    @staticmethod
    def _normalize_merchant_name(name: str) -> str:
        """标准化商家名：去空格、转小写、去特殊符号"""
        import re
        if not name:
            return ""
        n = name.strip().lower()
        n = re.sub(r'[^\w]', '', n)
        return n

    # ------------------------------------------------------------------
    # 商家 CRUD
    # ------------------------------------------------------------------

    @staticmethod
    def list_merchants(
        db: Session,
        *,
        platform: Optional[str] = None,
        category: Optional[str] = None,
        status: Optional[str] = None,
        assigned: Optional[bool] = None,
        missing_mid: Optional[bool] = None,
        relationship_status: Optional[str] = None,
        search: Optional[str] = None,
        start_date: Optional[date] = None,
        end_date: Optional[date] = None,
        page: int = 1,
        page_size: int = 50,
    ) -> dict:
        """分页查询商家列表"""
        q = db.query(AffiliateMerchant)

        if platform:
            q = q.filter(AffiliateMerchant.platform.ilike(f"%{platform}%"))
        if category:
            q = q.filter(AffiliateMerchant.category == category)
        if status:
            q = q.filter(AffiliateMerchant.status == status)
        if relationship_status:
            q = q.filter(AffiliateMerchant.relationship_status == relationship_status)
        if search:
            q = q.filter(
                or_(
                    AffiliateMerchant.merchant_name.ilike(f"%{search}%"),
                    AffiliateMerchant.merchant_id.ilike(f"%{search}%"),
                    AffiliateMerchant.slug.ilike(f"%{search}%"),
                )
            )

        if assigned is True:
            q = q.filter(
                AffiliateMerchant.id.in_(
                    db.query(MerchantAssignment.merchant_id).filter(
                        MerchantAssignment.status == "active"
                    )
                )
            )
        elif assigned is False:
            q = q.filter(
                ~AffiliateMerchant.id.in_(
                    db.query(MerchantAssignment.merchant_id).filter(
                        MerchantAssignment.status == "active"
                    )
                )
            )

        if missing_mid is True:
            q = q.filter(AffiliateMerchant.missing_mid == 1)
        elif missing_mid is False:
            q = q.filter(AffiliateMerchant.missing_mid == 0)

        total = q.count()
        items = (
            q.order_by(
                # 推荐商家优先排序
                (AffiliateMerchant.recommendation_status == "recommended").desc(),
                AffiliateMerchant.platform,
                AffiliateMerchant.merchant_name,
            )
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )

        merchant_ids = [m.id for m in items]
        assignments = (
            db.query(MerchantAssignment)
            .options(joinedload(MerchantAssignment.user))
            .filter(
                MerchantAssignment.merchant_id.in_(merchant_ids),
                MerchantAssignment.status == "active",
            )
            .all()
        ) if merchant_ids else []
        assign_map = {}
        for a in assignments:
            assign_map.setdefault(a.merchant_id, []).append(a)

        now = datetime.now(timezone.utc)
        range_start = datetime.combine(start_date, datetime.min.time()).replace(tzinfo=timezone.utc) if start_date else (now - timedelta(days=30))
        range_end = datetime.combine(end_date, datetime.max.time()).replace(tzinfo=timezone.utc) if end_date else now

        commission_rows = (
            db.query(
                AffiliateMerchant.id,
                func.coalesce(func.sum(AffiliateTransaction.commission_amount), 0).label("commission_30d"),
                func.count(distinct(AffiliateTransaction.transaction_id)).label("orders_30d"),
            )
            .outerjoin(
                AffiliateTransaction,
                and_(
                    func.lower(AffiliateTransaction.platform) == func.lower(AffiliateMerchant.platform),
                    AffiliateTransaction.merchant_id == AffiliateMerchant.merchant_id,
                    AffiliateTransaction.transaction_time >= range_start,
                    AffiliateTransaction.transaction_time <= range_end,
                ),
            )
            .filter(AffiliateMerchant.id.in_(merchant_ids))
            .group_by(AffiliateMerchant.id)
            .all()
        ) if merchant_ids else []
        perf_map = {r.id: {"commission_30d": float(r.commission_30d), "orders_30d": r.orders_30d} for r in commission_rows}

        # CR-048b: 在投人数 — 基于 GoogleAdsApiData 中已启用广告（近30天）
        ads_since = (now - timedelta(days=30)).date() if hasattr(now - timedelta(days=30), 'date') else (datetime.now() - timedelta(days=30)).date()
        advertiser_rows = (
            db.query(
                AffiliateMerchant.id,
                func.count(distinct(GoogleAdsApiData.user_id)).label("active_advertisers"),
            )
            .join(
                GoogleAdsApiData,
                and_(
                    func.rtrim(func.lower(GoogleAdsApiData.extracted_platform_code), '0123456789') == func.lower(AffiliateMerchant.platform),
                    GoogleAdsApiData.extracted_account_code == AffiliateMerchant.merchant_id,
                    GoogleAdsApiData.date >= ads_since,
                    GoogleAdsApiData.status == "\u5df2\u542f\u7528",
                ),
            )
            .filter(AffiliateMerchant.id.in_(merchant_ids))
            .group_by(AffiliateMerchant.id)
            .all()
        ) if merchant_ids else []
        active_advertiser_map = {r.id: r.active_advertisers for r in advertiser_rows}

        split_map = MerchantService._batch_commission_split(db, items, assign_map, range_start, range_end) if merchant_ids else {}

        result = []
        for m in items:
            assigns = assign_map.get(m.id, [])
            perf = perf_map.get(m.id, {"commission_30d": 0, "orders_30d": 0})
            split = split_map.get(m.id, {"self_run_commission": 0, "assigned_commission": 0})
            result.append({
                "id": m.id,
                "merchant_id": m.merchant_id,
                "merchant_name": m.merchant_name,
                "platform": MerchantService.normalize_platform(m.platform),
                "slug": m.slug,
                "category": m.category,
                "commission_rate": m.commission_rate,
                "status": m.status,
                "relationship_status": m.relationship_status or "unknown",
                "missing_mid": bool(m.missing_mid),
                "violation_status": getattr(m, 'violation_status', 'normal') or 'normal',
                "recommendation_status": getattr(m, 'recommendation_status', 'normal') or 'normal',
                "notes": m.notes,
                "created_at": m.created_at.isoformat() if m.created_at else None,
                "assigned_users": [
                    {
                        "assignment_id": a.id,
                        "user_id": a.user_id,
                        "username": a.user.username if a.user else None,
                        "display_name": a.user.display_name if a.user else None,
                        "priority": a.priority,
                        "monthly_target": float(a.monthly_target) if a.monthly_target else None,
                        "google_campaign_id": a.google_campaign_id,
                        "daily_budget": float(a.daily_budget) if a.daily_budget else None,
                        "mode": a.mode,
                    }
                    for a in assigns
                ],
                "active_advertiser_count": active_advertiser_map.get(m.id, 0),
                **perf,
                **split,
            })

        return {"total": total, "page": page, "page_size": page_size, "items": result}

    @staticmethod
    def get_merchant(db: Session, merchant_pk: int) -> Optional[dict]:
        """获取商家详情"""
        m = db.query(AffiliateMerchant).get(merchant_pk)
        if not m:
            return None

        assigns = (
            db.query(MerchantAssignment)
            .options(joinedload(MerchantAssignment.user), joinedload(MerchantAssignment.assigner))
            .filter(MerchantAssignment.merchant_id == m.id)
            .order_by(MerchantAssignment.assigned_at.desc())
            .all()
        )

        now = datetime.now(timezone.utc)
        start_30d = now - timedelta(days=30)
        perf = db.query(
            func.coalesce(func.sum(AffiliateTransaction.commission_amount), 0).label("commission"),
            func.coalesce(func.sum(AffiliateTransaction.order_amount), 0).label("gmv"),
            func.count(distinct(AffiliateTransaction.transaction_id)).label("orders"),
        ).filter(
            AffiliateTransaction.platform == m.platform,
            AffiliateTransaction.merchant_id == m.merchant_id,
            AffiliateTransaction.transaction_time >= start_30d,
        ).first()

        return {
            "id": m.id,
            "merchant_id": m.merchant_id,
            "merchant_name": m.merchant_name,
            "platform": m.platform,
            "slug": m.slug,
            "category": m.category,
            "commission_rate": m.commission_rate,
            "logo_url": m.logo_url,
            "status": m.status,
            "missing_mid": bool(m.missing_mid),
            "notes": m.notes,
            "created_at": m.created_at.isoformat() if m.created_at else None,
            "updated_at": m.updated_at.isoformat() if m.updated_at else None,
            "assignments": [
                {
                    "id": a.id,
                    "user_id": a.user_id,
                    "username": a.user.username if a.user else None,
                    "display_name": a.user.display_name if a.user else None,
                    "assigned_by_name": a.assigner.display_name if a.assigner else None,
                    "status": a.status,
                    "priority": a.priority,
                    "monthly_target": float(a.monthly_target) if a.monthly_target else None,
                    "notes": a.notes,
                    "assigned_at": a.assigned_at.isoformat() if a.assigned_at else None,
                }
                for a in assigns
            ],
            "performance_30d": {
                "commission": float(perf.commission) if perf else 0,
                "gmv": float(perf.gmv) if perf else 0,
                "orders": perf.orders if perf else 0,
            },
        }

    @staticmethod
    def update_merchant(db: Session, merchant_pk: int, data: dict) -> Optional[AffiliateMerchant]:
        """更新商家信息"""
        m = db.query(AffiliateMerchant).get(merchant_pk)
        if not m:
            return None
        for field in ("category", "commission_rate", "logo_url", "status", "notes", "slug",
                      "violation_status", "recommendation_status"):
            if field in data:
                setattr(m, field, data[field])

        if "merchant_id" in data:
            mid_value = data.get("merchant_id")
            if mid_value in (None, ""):
                m.merchant_id = None
                m.missing_mid = 1
            else:
                mid_str = str(mid_value).strip()
                if not mid_str.isdigit():
                    raise ValueError("merchant_id 必须为纯数字 MID")
                m.merchant_id = mid_str
                m.missing_mid = 0
                m.id_confidence = "manual"
                repair = (
                    db.query(MerchantMidRepairQueue)
                    .filter(
                        MerchantMidRepairQueue.merchant_id == m.id,
                        MerchantMidRepairQueue.repair_status.in_(["pending", "auto_matched"]),
                    )
                    .all()
                )
                for r in repair:
                    r.repair_status = "manual_fixed"
                    r.repaired_mid = mid_str
        db.commit()
        db.refresh(m)
        return m

    @staticmethod
    def get_stats(db: Session, user_id: int = None) -> dict:
        """商家统计概览"""
        total = db.query(func.count(AffiliateMerchant.id)).scalar() or 0
        assigned_ids = (
            db.query(distinct(MerchantAssignment.merchant_id))
            .filter(MerchantAssignment.status == "active")
            .subquery()
        )
        assigned = db.query(func.count()).select_from(assigned_ids).scalar() or 0
        unassigned = total - assigned

        platform_dist = (
            db.query(AffiliateMerchant.platform, func.count(AffiliateMerchant.id))
            .group_by(AffiliateMerchant.platform)
            .all()
        )

        missing_mid_total = (
            db.query(func.count(AffiliateMerchant.id))
            .filter(AffiliateMerchant.missing_mid == 1)
            .scalar()
            or 0
        )

        transaction_total = db.query(func.count(AffiliateTransaction.id)).scalar() or 0
        transaction_with_mid = (
            db.query(func.count(AffiliateTransaction.id))
            .filter(
                AffiliateTransaction.merchant_id.isnot(None),
                AffiliateTransaction.merchant_id != "",
            )
            .scalar()
            or 0
        )

        discovery_rate = round((transaction_with_mid / transaction_total) * 100, 2) if transaction_total else 100.0
        missing_mid_rate = round(100.0 - discovery_rate, 2) if transaction_total else 0.0

        missing_mid_by_platform = (
            db.query(
                AffiliateTransaction.platform,
                func.count(AffiliateTransaction.id).label("cnt"),
            )
            .filter(
                or_(
                    AffiliateTransaction.merchant_id.is_(None),
                    AffiliateTransaction.merchant_id == "",
                )
            )
            .group_by(AffiliateTransaction.platform)
            .all()
        )

        norm_platform: dict = {}
        for p, c in platform_dist:
            key = MerchantService.normalize_platform(p) if p else (p or "UNKNOWN")
            norm_platform[key] = norm_platform.get(key, 0) + c

        norm_missing: dict = {}
        for p, c in missing_mid_by_platform:
            key = MerchantService.normalize_platform(p) if p else (p or "UNKNOWN")
            norm_missing[key] = norm_missing.get(key, 0) + c

        test_q = db.query(func.count(MerchantAssignment.id)).filter(
            MerchantAssignment.mode == "test",
            MerchantAssignment.status == "active",
        )
        if user_id:
            test_q = test_q.filter(MerchantAssignment.user_id == user_id)
        test_merchant_count = test_q.scalar() or 0

        return {
            "total": total,
            "assigned": assigned,
            "unassigned": unassigned,
            "missing_mid_total": missing_mid_total,
            "discovery_rate": discovery_rate,
            "missing_mid_rate": missing_mid_rate,
            "by_platform": norm_platform,
            "missing_mid_by_platform": norm_missing,
            "test_merchant_count": test_merchant_count,
        }

    # ------------------------------------------------------------------
    # 分配管理
    # ------------------------------------------------------------------

    @staticmethod
    def assign_merchants(
        db: Session,
        merchant_ids: list[int],
        user_id: int,
        assigned_by: int,
        priority: str = "normal",
        monthly_target: Optional[float] = None,
        notes: Optional[str] = None,
    ) -> list[MerchantAssignment]:
        """批量分配商家给员工"""
        target_user = db.query(User).get(user_id)
        if not target_user:
            raise ValueError("目标员工不存在")

        existing = set(
            r[0]
            for r in db.query(MerchantAssignment.merchant_id)
            .filter(
                MerchantAssignment.merchant_id.in_(merchant_ids),
                MerchantAssignment.user_id == user_id,
                MerchantAssignment.status == "active",
            )
            .all()
        )

        created = []
        merchant_names = []
        for mid in merchant_ids:
            if mid in existing:
                continue
            a = MerchantAssignment(
                merchant_id=mid,
                user_id=user_id,
                assigned_by=assigned_by,
                priority=priority,
                monthly_target=monthly_target,
                notes=notes,
            )
            db.add(a)
            created.append(a)
            m = db.query(AffiliateMerchant).get(mid)
            if m:
                merchant_names.append(m.merchant_name)

        if created:
            db.flush()
            notification = Notification(
                user_id=user_id,
                type="merchant_assigned",
                title="商家分配通知",
                content=f"您被分配了 {len(created)} 个新商家: {', '.join(merchant_names[:5])}{'...' if len(merchant_names) > 5 else ''}",
            )
            db.add(notification)
            for a in created:
                db.add(MerchantAssignmentEvent(
                    assignment_id=a.id,
                    event_type="created",
                    new_value=f"user_id={user_id}, priority={priority}",
                    operator_id=assigned_by,
                ))
            db.commit()
            logger.info(f"[商家分配] 分配 {len(created)} 个商家给用户 {user_id}")

        return created

    @staticmethod
    def list_assignments(
        db: Session,
        *,
        user: Optional[User] = None,
        user_id: Optional[int] = None,
        status: Optional[str] = None,
        page: int = 1,
        page_size: int = 50,
    ) -> dict:
        """查询分配列表（按权限过滤）"""
        q = (
            db.query(MerchantAssignment)
            .options(
                joinedload(MerchantAssignment.merchant),
                joinedload(MerchantAssignment.user),
                joinedload(MerchantAssignment.assigner),
            )
        )

        if user:
            if user.role == "member" or user.role == "employee":
                q = q.filter(MerchantAssignment.user_id == user.id)
            elif user.role == "leader" and user.team_id:
                team_user_ids = [
                    u.id for u in db.query(User.id).filter(User.team_id == user.team_id).all()
                ]
                q = q.filter(MerchantAssignment.user_id.in_(team_user_ids))

        if user_id:
            q = q.filter(MerchantAssignment.user_id == user_id)
        if status:
            q = q.filter(MerchantAssignment.status == status)

        total = q.count()
        items = (
            q.order_by(MerchantAssignment.assigned_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )

        return {
            "total": total,
            "page": page,
            "page_size": page_size,
            "items": [
                {
                    "id": a.id,
                    "merchant": {
                        "id": a.merchant.id,
                        "merchant_id": a.merchant.merchant_id,
                        "merchant_name": a.merchant.merchant_name,
                        "platform": a.merchant.platform,
                    } if a.merchant else None,
                    "user_id": a.user_id,
                    "username": a.user.username if a.user else None,
                    "display_name": a.user.display_name if a.user else None,
                    "assigned_by_name": a.assigner.display_name if a.assigner else None,
                    "status": a.status,
                    "priority": a.priority,
                    "monthly_target": float(a.monthly_target) if a.monthly_target else None,
                    "notes": a.notes,
                    "assigned_at": a.assigned_at.isoformat() if a.assigned_at else None,
                    "completed_at": a.completed_at.isoformat() if a.completed_at else None,
                    "mode": a.mode,
                    "assignment_source": a.assignment_source,
                    "google_campaign_id": a.google_campaign_id,
                    "google_customer_id": a.google_customer_id,
                    "daily_budget": float(a.daily_budget) if a.daily_budget else None,
                    "target_country": a.target_country,
                }
                for a in items
            ],
        }

    @staticmethod
    def update_assignment(db: Session, assignment_id: int, data: dict, operator_id: Optional[int] = None) -> Optional[MerchantAssignment]:
        """修改分配"""
        a = db.query(MerchantAssignment).get(assignment_id)
        if not a:
            return None
        old_vals = {f: getattr(a, f) for f in ("priority", "monthly_target", "notes", "status") if f in data}
        for field in ("priority", "monthly_target", "notes", "status"):
            if field in data:
                setattr(a, field, data[field])
        if data.get("status") == "completed" and not a.completed_at:
            a.completed_at = datetime.now(timezone.utc)
        new_vals = {f: getattr(a, f) for f in old_vals}
        event_type = "completed" if data.get("status") == "completed" else "updated"
        db.add(MerchantAssignmentEvent(
            assignment_id=assignment_id,
            event_type=event_type,
            old_value=str(old_vals),
            new_value=str(new_vals),
            operator_id=operator_id,
        ))
        db.commit()
        db.refresh(a)
        return a

    @staticmethod
    def delete_assignment(db: Session, assignment_id: int, operator_id: Optional[int] = None) -> bool:
        """取消分配"""
        a = db.query(MerchantAssignment).get(assignment_id)
        if not a:
            return False
        a.status = "cancelled"
        db.add(MerchantAssignmentEvent(
            assignment_id=assignment_id,
            event_type="cancelled",
            old_value="status=active",
            new_value="status=cancelled",
            operator_id=operator_id,
        ))
        db.commit()
        return True

    @staticmethod
    def transfer_assignments(
        db: Session,
        assignment_ids: list[int],
        new_user_id: int,
        transferred_by: int,
    ) -> int:
        """批量转移分配"""
        target_user = db.query(User).get(new_user_id)
        if not target_user:
            raise ValueError("目标员工不存在")

        assignments = (
            db.query(MerchantAssignment)
            .filter(
                MerchantAssignment.id.in_(assignment_ids),
                MerchantAssignment.status == "active",
            )
            .all()
        )

        count = 0
        merchant_names = []
        for a in assignments:
            old_user_id = a.user_id
            a.status = "cancelled"
            db.add(MerchantAssignmentEvent(
                assignment_id=a.id,
                event_type="transferred",
                old_value=f"user_id={old_user_id}",
                new_value=f"user_id={new_user_id}",
                operator_id=transferred_by,
            ))
            new_a = MerchantAssignment(
                merchant_id=a.merchant_id,
                user_id=new_user_id,
                assigned_by=transferred_by,
                priority=a.priority,
                monthly_target=a.monthly_target,
                notes=f"从用户{old_user_id}转移; {a.notes or ''}".strip(),
            )
            db.add(new_a)
            db.flush()
            db.add(MerchantAssignmentEvent(
                assignment_id=new_a.id,
                event_type="created",
                new_value=f"transferred from assignment {a.id}, user_id={new_user_id}",
                operator_id=transferred_by,
            ))
            count += 1
            m = db.query(AffiliateMerchant).get(a.merchant_id)
            if m:
                merchant_names.append(m.merchant_name)

        if count:
            notification = Notification(
                user_id=new_user_id,
                type="merchant_assigned",
                title="商家转移通知",
                content=f"有 {count} 个商家已转移给您: {', '.join(merchant_names[:5])}{'...' if len(merchant_names) > 5 else ''}",
            )
            db.add(notification)
            db.commit()
            logger.info(f"[商家转移] 转移 {count} 个分配给用户 {new_user_id}")

        return count

    # ------------------------------------------------------------------
    # 绩效查询
    # ------------------------------------------------------------------

    @staticmethod
    def get_performance(
        db: Session,
        *,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        user_id: Optional[int] = None,
        platform: Optional[str] = None,
        user: Optional[User] = None,
    ) -> list[dict]:
        """按员工+商家聚合绩效数据"""
        if not start_date:
            start_date = datetime.now(timezone.utc) - timedelta(days=30)
        if not end_date:
            end_date = datetime.now(timezone.utc)

        q = (
            db.query(
                MerchantAssignment.user_id,
                User.username,
                User.display_name,
                AffiliateMerchant.id.label("am_id"),
                AffiliateMerchant.merchant_name,
                AffiliateMerchant.platform,
                AffiliateMerchant.merchant_id.label("mid"),
                MerchantAssignment.monthly_target,
                func.count(distinct(AffiliateTransaction.transaction_id)).label("orders"),
                func.coalesce(func.sum(AffiliateTransaction.order_amount), 0).label("gmv"),
                func.coalesce(func.sum(AffiliateTransaction.commission_amount), 0).label("commission"),
            )
            .join(AffiliateMerchant, MerchantAssignment.merchant_id == AffiliateMerchant.id)
            .join(User, MerchantAssignment.user_id == User.id)
            .outerjoin(
                AffiliateTransaction,
                and_(
                    AffiliateTransaction.platform == AffiliateMerchant.platform,
                    AffiliateTransaction.merchant_id == AffiliateMerchant.merchant_id,
                    AffiliateTransaction.transaction_time >= start_date,
                    AffiliateTransaction.transaction_time <= end_date,
                ),
            )
            .filter(MerchantAssignment.status == "active")
        )

        if user_id:
            q = q.filter(MerchantAssignment.user_id == user_id)
        if platform:
            q = q.filter(AffiliateMerchant.platform.ilike(f"%{platform}%"))
        if user:
            if user.role in ("member", "employee"):
                q = q.filter(MerchantAssignment.user_id == user.id)
            elif user.role == "leader" and user.team_id:
                team_ids = [u.id for u in db.query(User.id).filter(User.team_id == user.team_id).all()]
                q = q.filter(MerchantAssignment.user_id.in_(team_ids))

        rows = q.group_by(
            MerchantAssignment.user_id,
            User.username,
            User.display_name,
            AffiliateMerchant.id,
            AffiliateMerchant.merchant_name,
            AffiliateMerchant.platform,
            AffiliateMerchant.merchant_id,
            MerchantAssignment.monthly_target,
        ).all()

        return [
            {
                "user_id": r.user_id,
                "username": r.username,
                "display_name": r.display_name,
                "merchant_id": r.am_id,
                "merchant_name": r.merchant_name,
                "platform": r.platform,
                "mid": r.mid,
                "monthly_target": float(r.monthly_target) if r.monthly_target else None,
                "orders": r.orders,
                "gmv": float(r.gmv),
                "commission": float(r.commission),
            }
            for r in rows
        ]

    @staticmethod
    def get_ranking(
        db: Session,
        *,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        user: Optional[User] = None,
    ) -> list[dict]:
        """员工绩效排名"""
        if not start_date:
            start_date = datetime.now(timezone.utc) - timedelta(days=30)
        if not end_date:
            end_date = datetime.now(timezone.utc)

        q = (
            db.query(
                MerchantAssignment.user_id,
                User.username,
                User.display_name,
                func.count(distinct(AffiliateMerchant.id)).label("merchant_count"),
                func.count(distinct(AffiliateTransaction.transaction_id)).label("orders"),
                func.coalesce(func.sum(AffiliateTransaction.order_amount), 0).label("gmv"),
                func.coalesce(func.sum(AffiliateTransaction.commission_amount), 0).label("commission"),
                func.coalesce(func.sum(MerchantAssignment.monthly_target), 0).label("total_target"),
            )
            .join(AffiliateMerchant, MerchantAssignment.merchant_id == AffiliateMerchant.id)
            .join(User, MerchantAssignment.user_id == User.id)
            .outerjoin(
                AffiliateTransaction,
                and_(
                    AffiliateTransaction.platform == AffiliateMerchant.platform,
                    AffiliateTransaction.merchant_id == AffiliateMerchant.merchant_id,
                    AffiliateTransaction.transaction_time >= start_date,
                    AffiliateTransaction.transaction_time <= end_date,
                ),
            )
            .filter(MerchantAssignment.status == "active")
        )

        if user:
            if user.role == "leader" and user.team_id:
                team_ids = [u.id for u in db.query(User.id).filter(User.team_id == user.team_id).all()]
                q = q.filter(MerchantAssignment.user_id.in_(team_ids))
            elif user.role in ("member", "employee"):
                q = q.filter(MerchantAssignment.user_id == user.id)

        rows = (
            q.group_by(MerchantAssignment.user_id, User.username, User.display_name)
            .order_by(func.sum(AffiliateTransaction.commission_amount).desc())
            .all()
        )

        return [
            {
                "user_id": r.user_id,
                "username": r.username,
                "display_name": r.display_name,
                "merchant_count": r.merchant_count,
                "orders": r.orders,
                "gmv": float(r.gmv),
                "commission": float(r.commission),
                "total_target": float(r.total_target),
                "completion_rate": round(float(r.commission) / float(r.total_target) * 100, 1) if r.total_target else None,
            }
            for r in rows
        ]

    # ------------------------------------------------------------------
    # 在投人数详情
    # ------------------------------------------------------------------

    @staticmethod
    def get_active_advertisers(db: Session, merchant_pk: int) -> list:
        """获取某商家当前已启用广告的员工列表及其广告数据概要。"""
        m = db.query(AffiliateMerchant).get(merchant_pk)
        if not m or not m.merchant_id:
            return []

        ads_since = (datetime.now() - timedelta(days=30)).date()
        rows = (
            db.query(
                GoogleAdsApiData.user_id,
                User.username,
                User.display_name,
                func.count(distinct(GoogleAdsApiData.campaign_id)).label("campaign_count"),
                func.sum(GoogleAdsApiData.cost).label("total_cost"),
                func.sum(GoogleAdsApiData.clicks).label("total_clicks"),
                func.sum(GoogleAdsApiData.impressions).label("total_impressions"),
            )
            .join(User, GoogleAdsApiData.user_id == User.id)
            .filter(
                func.rtrim(func.lower(GoogleAdsApiData.extracted_platform_code), '0123456789') == func.lower(m.platform),
                GoogleAdsApiData.extracted_account_code == m.merchant_id,
                GoogleAdsApiData.date >= ads_since,
                GoogleAdsApiData.status == "\u5df2\u542f\u7528",
            )
            .group_by(GoogleAdsApiData.user_id, User.username, User.display_name)
            .order_by(func.sum(GoogleAdsApiData.cost).desc())
            .all()
        )

        return [
            {
                "user_id": r.user_id,
                "username": r.username,
                "display_name": r.display_name or r.username,
                "campaign_count": r.campaign_count,
                "total_cost": round(float(r.total_cost or 0), 2),
                "total_clicks": int(r.total_clicks or 0),
                "total_impressions": int(r.total_impressions or 0),
            }
            for r in rows
        ]

    # ------------------------------------------------------------------
    # OPT-009: 佣金拆分
    # ------------------------------------------------------------------

    @staticmethod
    def repair_all_lh_mid(db: Session) -> dict:
        """一键彻底补齐所有 LH 平台的纯数字 MID。
        1. 遍历所有 LH 账号 Token
        2. 对每个 Token 分别拉取 joined/notjoined/applying 三种 relationship 的商家
        3. 通过 cashback2 API 补充映射（覆盖交易中出现但商家目录中没有的）
        4. 修复 affiliate_transactions 表（缺失 + slug→数字）
        5. 修复 affiliate_merchants 表（缺失 + slug→数字 + 去重）
        6. 修复 affiliate_accounts 表 account_code
        """
        import httpx
        import time as _time
        from datetime import datetime as _dt

        from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
        from app.utils.crypto import decrypt_token
        import json as _json

        # ── Step 1: 收集所有 LH 账号的 Token ──
        lh_platform = (
            db.query(AffiliatePlatform)
            .filter(func.lower(AffiliatePlatform.platform_code) == "lh")
            .first()
        )
        if not lh_platform:
            return {"success": False, "message": "未找到 LH 平台配置"}

        lh_accounts = (
            db.query(AffiliateAccount)
            .filter(AffiliateAccount.platform_id == lh_platform.id)
            .all()
        )

        tokens = []
        for acct in lh_accounts:
            token = None
            if acct.api_token_encrypted:
                try:
                    token = decrypt_token(acct.api_token_encrypted)
                except Exception:
                    pass
            if not token and acct.notes:
                try:
                    notes = _json.loads(acct.notes)
                    for k in ("linkhaitao_token", "token", "api_token"):
                        if notes.get(k):
                            token = notes[k]
                            break
                except Exception:
                    pass
            if token and token not in tokens:
                tokens.append(token)

        if not tokens:
            return {"success": False, "message": "未找到有效的 LH API Token，请先配置"}

        # ── Step 2: 拉取全量商家 + cashback2，构建映射 ──
        # 注意：LH 两个 API 的 mcid/m_id 含义相反！
        #   merchantBasicList3: mcid = 纯数字, m_id = slug
        #   cashback2:          mcid = slug,   m_id = 纯数字
        slug_to_mid = {}   # slug → 纯数字 MID
        name_to_mid = {}   # merchant_name → 纯数字 MID
        total_fetched = 0

        def _parse_items(data):
            """从 LH API 响应中提取列表"""
            # merchantBasicList3 返回 {"list": [...]}
            # cashback2 返回 {"data": {"list": [...]}} 或 {"data": [...]}
            items = data.get("list") or data.get("data") or []
            if isinstance(items, dict):
                items = items.get("list", items.get("data", []))
            return items if isinstance(items, list) else []

        def _add_merchant_mapping(item):
            """从 merchantBasicList3 记录中提取映射
            此 API: mcid = 纯数字, m_id = slug, merchant_name = 商家名
            """
            mcid = str(item.get("mcid", "")).strip()   # 纯数字
            m_id = str(item.get("m_id", "")).strip()    # slug
            m_name = str(item.get("merchant_name", "")).strip()
            if mcid and mcid.isdigit() and mcid != "0":
                if m_id:
                    slug_to_mid[m_id.lower()] = mcid
                if m_name:
                    name_to_mid[m_name.lower()] = mcid
                return True
            return False

        def _add_order_mapping(item):
            """从 cashback2 订单记录中提取映射
            此 API: mcid = slug, m_id = 纯数字, advertiser_name = 商家名
            """
            mcid = str(item.get("mcid", "")).strip()   # slug
            m_id = str(item.get("m_id", "")).strip()    # 纯数字
            adv_name = str(item.get("advertiser_name", "")).strip()
            if m_id and m_id.isdigit() and m_id != "0":
                if mcid:
                    slug_to_mid[mcid.lower()] = m_id
                if adv_name:
                    name_to_mid[adv_name.lower()] = m_id
                return True
            return False

        api_url = "https://www.linkhaitao.com/api.php"

        for token in tokens:
            # 2a. merchantBasicList3 - 三种 relationship
            for rel in ("joined", "notjoined", "applying"):
                try:
                    resp = httpx.post(
                        f"{api_url}?mod=medium&op=merchantBasicList3",
                        data={
                            "token": token,
                            "relationship": rel,
                            "page": 1,
                            "per_page": 40000,
                        },
                        timeout=60,
                    )
                    items = _parse_items(resp.json())
                    for item in items:
                        _add_merchant_mapping(item)
                    total_fetched += len(items)
                    logger.info("[LH MID] merchantBasicList3 %s: %d 条", rel, len(items))
                except Exception as e:
                    logger.warning("[LH MID] merchantBasicList3 %s 失败: %s", rel, e)
                _time.sleep(4)  # LH rate limit: 3/10s

            # 2b. cashback2 - 补充交易中出现但商家目录中没有的
            try:
                resp = httpx.post(
                    f"{api_url}?mod=medium&op=cashback2",
                    data={
                        "token": token,
                        "begin_date": "2024-01-01",
                        "end_date": _dt.now().strftime("%Y-%m-%d"),
                        "page": 1,
                        "per_page": 40000,
                        "status": "all",
                    },
                    timeout=60,
                )
                orders = _parse_items(resp.json())
                extra = sum(1 for o in orders if _add_order_mapping(o))
                logger.info("[LH MID] cashback2: %d 条订单, %d 条新增映射", len(orders), extra)
            except Exception as e:
                logger.warning("[LH MID] cashback2 失败: %s", e)
            _time.sleep(4)

        logger.info("[LH MID] 总映射: slug=%d, name=%d (拉取 %d 条)",
                    len(slug_to_mid), len(name_to_mid), total_fetched)

        if not slug_to_mid and not name_to_mid:
            return {"success": False, "message": "API 未返回有效映射数据，请检查 Token 是否有效"}

        # ── 辅助：模糊匹配 ──
        def _fuzzy_resolve(key: str, mapping: dict) -> str | None:
            """精确匹配 → 大小写匹配 → 去尾 s 匹配"""
            k = key.strip().lower()
            if k in mapping:
                return mapping[k]
            k2 = k.rstrip("s")
            for mk, mv in mapping.items():
                if mk == k or mk.rstrip("s") == k2:
                    return mv
            return None

        # ── Step 3: 修复 affiliate_transactions ──
        lh_platforms = ["LH", "LH1", "LH2", "LH3", "lh", "lh1", "lh2", "lh3"]
        tx_name_fixed = 0
        tx_slug_fixed = 0

        # 3a. merchant_id 缺失 → 按 name 匹配
        lh_tx_missing = (
            db.query(AffiliateTransaction)
            .filter(
                AffiliateTransaction.platform.in_(lh_platforms),
                or_(
                    AffiliateTransaction.merchant_id.is_(None),
                    AffiliateTransaction.merchant_id == "",
                ),
            )
            .all()
        )
        for tx in lh_tx_missing:
            m_name = (tx.merchant or "").strip()
            resolved = _fuzzy_resolve(m_name, name_to_mid)
            if resolved:
                tx.merchant_id = resolved
                tx_name_fixed += 1

        # 3b. merchant_id 是 slug → 转数字
        lh_tx_slug = (
            db.query(AffiliateTransaction)
            .filter(
                AffiliateTransaction.platform.in_(lh_platforms),
                AffiliateTransaction.merchant_id.isnot(None),
                AffiliateTransaction.merchant_id != "",
            )
            .all()
        )
        for tx in lh_tx_slug:
            mid = tx.merchant_id.strip()
            if not mid.isdigit():
                resolved = _fuzzy_resolve(mid, slug_to_mid)
                if resolved:
                    tx.merchant_id = resolved
                    tx_slug_fixed += 1

        # ── Step 4: 修复 affiliate_merchants ──
        merchant_fixed = 0
        merchant_dup_deleted = 0

        # 4a. missing_mid=1 或 merchant_id 为空
        lh_m_missing = (
            db.query(AffiliateMerchant)
            .filter(
                func.lower(AffiliateMerchant.platform) == "lh",
                or_(
                    AffiliateMerchant.missing_mid == 1,
                    AffiliateMerchant.merchant_id.is_(None),
                    AffiliateMerchant.merchant_id == "",
                ),
            )
            .all()
        )
        for m in lh_m_missing:
            m_name = (m.merchant_name or "").strip()
            slug = (m.slug or "").strip()
            resolved = _fuzzy_resolve(m_name, name_to_mid) or _fuzzy_resolve(slug, slug_to_mid)
            if resolved:
                # 检查唯一约束冲突
                existing = db.query(AffiliateMerchant).filter(
                    func.lower(AffiliateMerchant.platform) == "lh",
                    AffiliateMerchant.merchant_id == resolved,
                    AffiliateMerchant.id != m.id,
                ).first()
                if existing:
                    db.delete(m)
                    merchant_dup_deleted += 1
                else:
                    m.merchant_id = resolved
                    m.missing_mid = 0
                    m.id_confidence = "api_repair"
                    merchant_fixed += 1

        # 4b. merchant_id 是 slug → 转数字
        lh_m_slug = (
            db.query(AffiliateMerchant)
            .filter(
                func.lower(AffiliateMerchant.platform) == "lh",
                AffiliateMerchant.merchant_id.isnot(None),
                AffiliateMerchant.merchant_id != "",
            )
            .all()
        )
        merchant_slug_fixed = 0
        for m in lh_m_slug:
            mid = m.merchant_id.strip()
            if not mid.isdigit():
                resolved = _fuzzy_resolve(mid, slug_to_mid)
                if resolved:
                    existing = db.query(AffiliateMerchant).filter(
                        func.lower(AffiliateMerchant.platform) == "lh",
                        AffiliateMerchant.merchant_id == resolved,
                        AffiliateMerchant.id != m.id,
                    ).first()
                    if existing:
                        db.delete(m)
                        merchant_dup_deleted += 1
                    else:
                        m.merchant_id = resolved
                        m.missing_mid = 0
                        m.id_confidence = "api_repair"
                        merchant_slug_fixed += 1

        # ── Step 5: 修复 affiliate_accounts.account_code ──
        acct_fixed = 0
        for acct in lh_accounts:
            old_code = (acct.account_code or "").strip()
            if not old_code or old_code.isdigit():
                continue
            resolved = _fuzzy_resolve(old_code, slug_to_mid)
            if resolved:
                acct.account_code = resolved
                acct_fixed += 1

        db.commit()

        result = {
            "success": True,
            "api_merchants_fetched": total_fetched,
            "slug_mappings": len(slug_to_mid),
            "name_mappings": len(name_to_mid),
            "tx_name_fixed": tx_name_fixed,
            "tx_slug_fixed": tx_slug_fixed,
            "tx_missing_total": len(lh_tx_missing),
            "merchants_fixed": merchant_fixed,
            "merchants_slug_fixed": merchant_slug_fixed,
            "merchants_dup_deleted": merchant_dup_deleted,
            "accounts_fixed": acct_fixed,
        }
        logger.info("[LH MID补齐] 完成: %s", result)
        return result

    @staticmethod
    def _batch_commission_split(
        db: Session,
        merchants: list,
        assign_map: dict,
        range_start: datetime,
        range_end: datetime,
    ) -> dict:
        """批量计算列表页每个商家的自跑/分配佣金汇总。"""
        result = {}
        for m in merchants:
            if not m.merchant_id:
                result[m.id] = {"self_run_commission": 0, "assigned_commission": 0}
                continue

            txs = (
                db.query(
                    AffiliateTransaction.user_id,
                    AffiliateTransaction.transaction_time,
                    AffiliateTransaction.commission_amount,
                )
                .filter(
                    func.lower(AffiliateTransaction.platform) == func.lower(m.platform),
                    AffiliateTransaction.merchant_id == m.merchant_id,
                    AffiliateTransaction.transaction_time >= range_start,
                    AffiliateTransaction.transaction_time <= range_end,
                )
                .all()
            )

            assigns = assign_map.get(m.id, [])
            assigned_map = {a.user_id: a.assigned_at for a in assigns if a.assigned_at}

            self_run = 0.0
            assigned = 0.0
            for tx in txs:
                amt = float(tx.commission_amount or 0)
                assigned_at = assigned_map.get(tx.user_id)
                if assigned_at and tx.transaction_time and tx.transaction_time >= assigned_at:
                    assigned += amt
                else:
                    self_run += amt

            result[m.id] = {
                "self_run_commission": round(self_run, 2),
                "assigned_commission": round(assigned, 2),
            }
        return result

    @staticmethod
    def get_commission_breakdown(
        db: Session,
        merchant_pk: int,
        start_date: date,
        end_date: date,
        current_user=None,
    ) -> dict:
        """获取单个商家的佣金拆分明细（OPT-009 §10.5）。"""
        m = db.query(AffiliateMerchant).get(merchant_pk)
        if not m:
            return None

        range_start = datetime.combine(start_date, datetime.min.time()).replace(tzinfo=timezone.utc)
        range_end = datetime.combine(end_date, datetime.max.time()).replace(tzinfo=timezone.utc)

        tx_query = (
            db.query(
                AffiliateTransaction.user_id,
                AffiliateTransaction.transaction_time,
                AffiliateTransaction.commission_amount,
                AffiliateTransaction.transaction_id,
            )
            .filter(
                func.lower(AffiliateTransaction.platform) == func.lower(m.platform),
                AffiliateTransaction.merchant_id == m.merchant_id,
                AffiliateTransaction.transaction_time >= range_start,
                AffiliateTransaction.transaction_time <= range_end,
            )
        )

        if current_user:
            role = current_user.role if isinstance(current_user.role, str) else current_user.role.value
            if role in ("member", "employee"):
                tx_query = tx_query.filter(AffiliateTransaction.user_id == current_user.id)
            elif role == "leader" and current_user.team_id:
                team_uids = [u.id for u in db.query(User.id).filter(User.team_id == current_user.team_id).all()]
                tx_query = tx_query.filter(AffiliateTransaction.user_id.in_(team_uids))

        txs = tx_query.all()

        active_assigns = (
            db.query(MerchantAssignment)
            .filter(MerchantAssignment.merchant_id == m.id, MerchantAssignment.status == "active")
            .all()
        )
        assigned_map = {a.user_id: a.assigned_at for a in active_assigns if a.assigned_at}

        user_ids = set(tx.user_id for tx in txs if tx.user_id)
        users = {u.id: u for u in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}

        self_run_agg: dict = {}
        assigned_agg: dict = {}

        for tx in txs:
            uid = tx.user_id
            amt = float(tx.commission_amount or 0)
            assigned_at = assigned_map.get(uid)

            if assigned_at and tx.transaction_time and tx.transaction_time >= assigned_at:
                bucket = assigned_agg
            else:
                bucket = self_run_agg

            if uid not in bucket:
                bucket[uid] = {"commission": 0.0, "order_count": 0}
            bucket[uid]["commission"] += amt
            bucket[uid]["order_count"] += 1

        def _build_details(agg, include_assigned_at=False):
            details = []
            for uid, data in agg.items():
                u = users.get(uid)
                entry = {
                    "user_id": uid,
                    "username": u.username if u else None,
                    "display_name": u.display_name if u else None,
                    "commission": round(data["commission"], 2),
                    "order_count": data["order_count"],
                }
                if include_assigned_at:
                    entry["assigned_at"] = assigned_map.get(uid, "").isoformat() if assigned_map.get(uid) else None
                details.append(entry)
            return sorted(details, key=lambda x: x["commission"], reverse=True)

        self_run_total = round(sum(d["commission"] for d in self_run_agg.values()), 2)
        assigned_total = round(sum(d["commission"] for d in assigned_agg.values()), 2)

        return {
            "self_run_total": self_run_total,
            "assigned_total": assigned_total,
            "self_run_details": _build_details(self_run_agg),
            "assigned_details": _build_details(assigned_agg, include_assigned_at=True),
        }
