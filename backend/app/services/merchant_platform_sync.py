"""
商家平台 API 同步服务（OPT-009）

对 7 个联盟平台（CF / CG / BSH / PM / LB / LH / RW）拉取商家列表和申请状态，
写入 AffiliateMerchant + MerchantAccountRelationship，并在状态变更时生成通知。
"""
import json
import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import httpx

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.merchant import AffiliateMerchant
from app.models.merchant_account_relationship import MerchantAccountRelationship
from app.models.notification import Notification
from app.models.user import User, UserRole
from app.services.api_analysis_service import ApiAnalysisService
from app.utils.crypto import decrypt_token

logger = logging.getLogger(__name__)

PLATFORM_API_CONFIG: Dict[str, dict] = {
    "CF": {
        "mode": "post_json",
        "url": "https://api.creatorflare.com/api/monetization",
        "source": "creatorflare",
        "page_key": "curPage",
        "size_key": "perPage",
        "max_size": 2000,
    },
    "CG": {
        "mode": "post_json",
        "url": "https://api.collabglow.com/api/monetization",
        "source": "collabglow",
        "page_key": "curPage",
        "size_key": "perPage",
        "max_size": 2000,
    },
    "BSH": {
        "mode": "post_json",
        "url": "https://api.brandsparkhub.com/api/monetization",
        "source": "brandsparkhub",
        "page_key": "curPage",
        "size_key": "perPage",
        "max_size": 2000,
    },
    "PM": {
        "mode": "post_json",
        "url": "https://api.partnermatic.com/api/monetization",
        "source": "partnermatic",
        "page_key": "curPage",
        "size_key": "perPage",
        "max_size": 2000,
    },
    "LB": {
        "mode": "get",
        "url": "https://www.linkbux.com/api.php?mod=medium&op=monetization_api",
        "page_key": "page",
        "size_key": "limit",
        "max_size": 1000,
    },
    "LH": {
        "mode": "get_post",
        "url": "https://www.linkhaitao.com/api.php?mod=medium&op=merchantBasicList3",
        "page_key": "page",
        "size_key": "per_page",
        "max_size": 40000,
    },
    "RW": {
        "mode": "post_form",
        "url": "https://admin.rewardoo.com/api.php?mod=medium&op=merchant_details",
        "page_key": "page",
        "size_key": "limit",
        "max_size": 1000,
    },
}

RELATIONSHIP_VALUES = ("Joined", "Pending", "Rejected")
STATUS_MAP = {"joined": "joined", "pending": "pending", "rejected": "rejected"}
PRIORITY = {"joined": 3, "pending": 2, "rejected": 1, "unknown": 0}


def _normalize_relationship(raw: str) -> str:
    return STATUS_MAP.get(raw.strip().lower(), raw.strip().lower())


def _map_merchant_fields(raw: dict, platform_code: str, mode: str) -> dict:
    """将平台响应字段映射为统一字典。"""
    if mode == "post_json" and platform_code != "PM":
        return {
            "mcid": raw.get("brand_id"),
            "mid": None,
            "merchant_name": raw.get("merchant_name", ""),
            "relationship": raw.get("relationship", ""),
            "logo": raw.get("logo"),
            "categories": raw.get("categories"),
            "commission_rate": raw.get("comm_rate"),
            "site_url": raw.get("site_url"),
        }
    elif platform_code == "PM":
        return {
            "mcid": raw.get("brandId"),
            "mid": None,
            "merchant_name": raw.get("merchantName", ""),
            "relationship": raw.get("relationship", ""),
            "logo": raw.get("logo"),
            "categories": raw.get("categories"),
            "commission_rate": raw.get("commRate"),
            "site_url": raw.get("siteUrl"),
        }
    elif platform_code == "LH":
        return {
            "mcid": raw.get("mcid"),
            "mid": raw.get("m_id"),
            "merchant_name": raw.get("merchant_name", ""),
            "relationship": raw.get("relationship", ""),
            "logo": raw.get("logo"),
            "categories": raw.get("categories"),
            "commission_rate": raw.get("comm_rate"),
            "site_url": raw.get("site_url"),
        }
    else:
        return {
            "mcid": raw.get("mcid"),
            "mid": raw.get("mid"),
            "merchant_name": raw.get("merchant_name", ""),
            "relationship": raw.get("relationship", ""),
            "logo": raw.get("logo"),
            "categories": raw.get("categories"),
            "commission_rate": raw.get("comm_rate"),
            "site_url": raw.get("site_url"),
        }


def _extract_mid(mapped: dict) -> Optional[str]:
    """提取纯数字 MID，非数字值忽略。"""
    for key in ("mid", "mcid"):
        val = mapped.get(key)
        if val is not None:
            s = str(val).strip()
            if s.isdigit():
                return s
    return None


class MerchantPlatformSyncService:

    def __init__(self, db: Session):
        self.db = db

    # ------------------------------------------------------------------
    # 入口
    # ------------------------------------------------------------------

    def sync_all(self) -> dict:
        """全量同步所有活跃账号，返回同步统计。"""
        accounts = (
            self.db.query(AffiliateAccount)
            .join(AffiliatePlatform)
            .filter(AffiliateAccount.is_active.is_(True))
            .all()
        )

        total = len(accounts)
        synced = 0
        failed = 0
        skipped = 0
        new_merchants = 0
        errors: List[str] = []

        for acct in accounts:
            try:
                platform_code = self._resolve_platform_code(acct)
                if platform_code not in PLATFORM_API_CONFIG:
                    errors.append(f"{platform_code} account {acct.account_name}: unsupported platform")
                    failed += 1
                    continue

                token = self._resolve_token(acct, platform_code)
                if not token:
                    skipped += 1
                    continue

                count = self._sync_single_account(acct, platform_code, token)
                new_merchants += count
                synced += 1
            except Exception as exc:
                logger.exception("sync account %s failed", acct.id)
                errors.append(f"{acct.platform.platform_code if acct.platform else '?'} account {acct.account_name}: {exc}")
                failed += 1

        status_changes = self._aggregate_and_notify()
        self.db.commit()

        return {
            "total_accounts": total,
            "synced_accounts": synced,
            "failed_accounts": failed,
            "skipped_no_token": skipped,
            "new_merchants": new_merchants,
            "status_changes": status_changes,
            "errors": errors,
        }

    # ------------------------------------------------------------------
    # 单账号同步
    # ------------------------------------------------------------------

    def _sync_single_account(self, acct: AffiliateAccount, platform_code: str, token: str) -> int:
        cfg = PLATFORM_API_CONFIG[platform_code]
        all_merchants: List[dict] = []

        for rel_value in RELATIONSHIP_VALUES:
            merchants = self._fetch_platform_merchants(cfg, platform_code, token, rel_value)
            all_merchants.extend(merchants)

        new_count = 0
        for raw in all_merchants:
            mapped = _map_merchant_fields(raw, platform_code, cfg["mode"])
            mid = _extract_mid(mapped)
            rel_status = _normalize_relationship(mapped["relationship"])

            merchant = self._upsert_merchant(platform_code, mapped, mid)
            if merchant._sa_instance_state.pending:
                new_count += 1

            self._upsert_relationship(merchant, acct, rel_status)

        self.db.flush()
        return new_count

    # ------------------------------------------------------------------
    # 平台 API 调用（含分页）
    # ------------------------------------------------------------------

    def _fetch_platform_merchants(self, cfg: dict, platform_code: str, token: str, relationship: str) -> List[dict]:
        mode = cfg["mode"]
        url = cfg["url"]
        page_key = cfg["page_key"]
        size_key = cfg["size_key"]
        max_size = cfg["max_size"]

        result: List[dict] = []
        page = 1

        while True:
            try:
                data = self._api_call(mode, url, platform_code, token, relationship, page, max_size, page_key, size_key, cfg)
            except Exception as exc:
                logger.warning("API call %s page %d failed: %s", platform_code, page, exc)
                break

            items = data if isinstance(data, list) else data.get("data", data.get("items", []))
            if not items:
                break

            if isinstance(items, dict):
                items = items.get("data", items.get("items", []))
            valid = [it for it in items if isinstance(it, dict)]
            if not valid:
                break

            result.extend(valid)

            if len(items) < max_size:
                break
            page += 1

        return result

    def _api_call(self, mode: str, url: str, platform_code: str, token: str,
                  relationship: str, page: int, per_page: int,
                  page_key: str, size_key: str, cfg: dict) -> dict:
        timeout = httpx.Timeout(30.0, connect=10.0)

        if mode == "post_json":
            payload = {
                "source": cfg["source"],
                "token": token,
                "relationship": relationship,
                page_key: page,
                size_key: per_page,
            }
            resp = httpx.post(url, json=payload, timeout=timeout)
        elif mode == "post_form":
            form_data = {
                "token": token,
                "relationship": relationship,
                page_key: str(page),
                size_key: str(per_page),
            }
            resp = httpx.post(url, data=form_data, timeout=timeout)
        elif mode in ("get", "get_post"):
            params = {
                "token": token,
                "relationship": relationship,
                page_key: str(page),
                size_key: str(per_page),
            }
            resp = httpx.get(url, params=params, timeout=timeout)
        else:
            raise ValueError(f"Unknown mode: {mode}")

        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------
    # Upsert 逻辑
    # ------------------------------------------------------------------

    def _upsert_merchant(self, platform_code: str, mapped: dict, mid: Optional[str]) -> AffiliateMerchant:
        canonical = ApiAnalysisService.normalize_platform_code(platform_code)
        name = mapped.get("merchant_name") or str(mid or "")

        if mid:
            merchant = (
                self.db.query(AffiliateMerchant)
                .filter(AffiliateMerchant.platform == canonical, AffiliateMerchant.merchant_id == mid)
                .first()
            )
        else:
            merchant = (
                self.db.query(AffiliateMerchant)
                .filter(AffiliateMerchant.platform == canonical, AffiliateMerchant.merchant_name == name)
                .first()
            )

        if merchant:
            if mapped.get("logo"):
                merchant.logo_url = mapped["logo"]
            if mapped.get("commission_rate"):
                merchant.commission_rate = str(mapped["commission_rate"])
            if mapped.get("categories"):
                cat = mapped["categories"]
                merchant.category = cat if isinstance(cat, str) else ", ".join(cat) if isinstance(cat, list) else str(cat)
            if mid and not merchant.merchant_id:
                merchant.merchant_id = mid
                merchant.missing_mid = 0
                merchant.id_confidence = "api"
            api_name = (mapped.get("merchant_name") or "").strip()[:200]
            if api_name:
                if merchant.source_type != "merchant_api":
                    merchant.merchant_name = api_name
                elif merchant.merchant_name in (merchant.merchant_id, "Unknown", "", None):
                    merchant.merchant_name = api_name
            merchant.source_type = "merchant_api"
        else:
            merchant = AffiliateMerchant(
                platform=canonical,
                merchant_id=mid,
                merchant_name=name[:200] if name else "Unknown",
                logo_url=mapped.get("logo"),
                commission_rate=str(mapped["commission_rate"]) if mapped.get("commission_rate") else None,
                category=mapped["categories"] if isinstance(mapped.get("categories"), str) else (
                    ", ".join(mapped["categories"]) if isinstance(mapped.get("categories"), list) else None
                ),
                slug=mapped.get("site_url"),
                missing_mid=0 if mid else 1,
                id_confidence="api" if mid else "low",
                source_type="merchant_api",
                status="active",
            )
            self.db.add(merchant)
            self.db.flush()

        return merchant

    def _upsert_relationship(self, merchant: AffiliateMerchant, acct: AffiliateAccount, rel_status: str):
        mar = (
            self.db.query(MerchantAccountRelationship)
            .filter(
                MerchantAccountRelationship.merchant_id == merchant.id,
                MerchantAccountRelationship.affiliate_account_id == acct.id,
            )
            .first()
        )

        now = datetime.now(timezone.utc)
        if mar:
            mar.previous_status = mar.relationship_status
            mar.relationship_status = rel_status
            mar.synced_at = now
        else:
            mar = MerchantAccountRelationship(
                merchant_id=merchant.id,
                affiliate_account_id=acct.id,
                relationship_status=rel_status,
                previous_status=None,
                synced_at=now,
            )
            self.db.add(mar)

    # ------------------------------------------------------------------
    # 聚合 & 通知
    # ------------------------------------------------------------------

    def _aggregate_and_notify(self) -> int:
        """聚合商家级 relationship_status，检测变更并发通知。返回变更数。"""
        merchants = self.db.query(AffiliateMerchant).filter(AffiliateMerchant.source_type == "merchant_api").all()

        change_count = 0
        changes: List[Tuple[str, str, str, str]] = []

        for m in merchants:
            rels = (
                self.db.query(MerchantAccountRelationship.relationship_status)
                .filter(MerchantAccountRelationship.merchant_id == m.id)
                .all()
            )
            if not rels:
                continue

            statuses = [r[0] for r in rels]
            best = max(statuses, key=lambda s: PRIORITY.get(s, 0))
            old_status = m.relationship_status

            if old_status != best:
                changes.append((m.merchant_name, m.platform, old_status or "unknown", best))
                m.relationship_status = best
                change_count += 1

        if changes:
            self._send_status_change_notifications(changes)

        # 标记 previous_status 已消费
        self.db.query(MerchantAccountRelationship).filter(
            MerchantAccountRelationship.previous_status != MerchantAccountRelationship.relationship_status,
        ).update(
            {MerchantAccountRelationship.previous_status: MerchantAccountRelationship.relationship_status},
            synchronize_session="fetch",
        )

        return change_count

    def _send_status_change_notifications(self, changes: List[Tuple[str, str, str, str]]):
        recipients = (
            self.db.query(User)
            .filter(
                or_(
                    User.role.in_([UserRole.MANAGER, UserRole.LEADER]),
                    User.role == UserRole.MEMBER,
                    User.role == UserRole.EMPLOYEE,
                )
            )
            .all()
        )

        for merchant_name, platform, old_st, new_st in changes:
            title = f"商家 {merchant_name} 在 {platform} 状态变更"
            content = f"{old_st} → {new_st}"
            for user in recipients:
                self.db.add(Notification(
                    user_id=user.id,
                    type="merchant_status_change",
                    title=title,
                    content=content,
                ))

    # ------------------------------------------------------------------
    # 辅助
    # ------------------------------------------------------------------

    def _resolve_platform_code(self, acct: AffiliateAccount) -> str:
        if acct.platform and acct.platform.platform_code:
            return ApiAnalysisService.normalize_platform_code(acct.platform.platform_code)
        return ""

    @staticmethod
    def _resolve_token(acct: AffiliateAccount, platform_code: str) -> Optional[str]:
        """优先 api_token_encrypted，回退到 notes 中的交易 Token（两者相同）。"""
        if acct.api_token_encrypted:
            try:
                return decrypt_token(acct.api_token_encrypted)
            except Exception:
                pass

        if not acct.notes:
            return None
        try:
            notes_data = json.loads(acct.notes)
        except (json.JSONDecodeError, TypeError):
            return None

        key_map = {
            "CG": ["collabglow_token", "api_token"],
            "RW": ["rewardoo_token", "rw_token", "api_token"],
            "LH": ["linkhaitao_token", "token"],
            "CF": ["creatorflare_token", "cf_token", "api_token"],
            "LB": ["linkbux_token", "lb_token", "api_token"],
            "PM": ["partnermatic_token", "pm_token", "api_token"],
            "BSH": ["bsh_token", "api_token", "token"],
        }
        candidates = key_map.get(platform_code, [platform_code.lower() + "_token", "api_token", "token"])
        for k in candidates:
            val = notes_data.get(k)
            if val and isinstance(val, str) and val.strip():
                return val.strip()
        return None
