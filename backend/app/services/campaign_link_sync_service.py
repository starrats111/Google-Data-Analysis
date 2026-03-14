"""
Campaign Link 缓存同步服务（OPT-016 / CR-037）

每天 05:00 全量同步所有用户在 7 个平台的 Joined 商家 campaign link，
写入 campaign_link_cache 表。商家数量 2000~8000，需全量分页遍历。
"""
import json
import logging
import time
from datetime import datetime, timezone
from typing import List, Optional

import httpx
from sqlalchemy.orm import Session

from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.campaign_link_cache import CampaignLinkCache
from app.models.user import User
from app.services.campaign_link_service import CampaignLinkService, REGION_LANGUAGE_MAP
from app.services.merchant_platform_sync import (
    MerchantPlatformSyncService,
    PLATFORM_API_CONFIG,
)

logger = logging.getLogger(__name__)

# 同步超时（单次 API 调用）
_TIMEOUT = httpx.Timeout(60.0, connect=15.0)


class CampaignLinkSyncService:
    """全量同步所有用户的 Campaign Link 到本地缓存。"""

    def __init__(self, db: Session):
        self.db = db

    def sync_all_users(self) -> dict:
        """同步所有用户的所有平台 campaign link。"""
        users = self.db.query(User).all()
        total_cached = 0
        total_errors = 0
        user_results = []

        for user in users:
            try:
                cached = self.sync_user(user.id)
                total_cached += cached
                user_results.append({"user_id": user.id, "username": user.username, "cached": cached})
                logger.info("[CampaignLinkSync] 用户 %s (ID=%d) 同步完成: %d 条", user.username, user.id, cached)
            except Exception as e:
                total_errors += 1
                logger.error("[CampaignLinkSync] 用户 %s (ID=%d) 同步失败: %s", user.username, user.id, e)
                user_results.append({"user_id": user.id, "username": user.username, "error": str(e)})

        return {
            "total_users": len(users),
            "total_cached": total_cached,
            "total_errors": total_errors,
            "details": user_results,
        }

    def sync_user(self, user_id: int) -> int:
        """同步单个用户在所有平台的 campaign link，返回缓存条数。"""
        accounts = (
            self.db.query(AffiliateAccount)
            .join(AffiliatePlatform)
            .filter(
                AffiliateAccount.user_id == user_id,
                AffiliateAccount.is_active.is_(True),
            )
            .all()
        )

        cached_count = 0
        for acct in accounts:
            platform_code = acct.platform.platform_code.upper()
            token = MerchantPlatformSyncService._resolve_token(acct, platform_code)
            if not token:
                logger.warning("[CampaignLinkSync] 用户 %d 平台 %s 无有效 Token，跳过", user_id, platform_code)
                continue

            try:
                count = self._sync_platform(user_id, platform_code, token)
                cached_count += count
                logger.info("[CampaignLinkSync] 用户 %d 平台 %s: 缓存 %d 条", user_id, platform_code, count)
            except Exception as e:
                logger.error("[CampaignLinkSync] 用户 %d 平台 %s 同步异常: %s", user_id, platform_code, e)

        return cached_count

    def sync_user_platform(self, user_id: int, platform_code: str) -> int:
        """同步单个用户在指定平台的 campaign link，返回缓存条数。"""
        platform_code = platform_code.upper()
        accounts = (
            self.db.query(AffiliateAccount)
            .join(AffiliatePlatform)
            .filter(
                AffiliateAccount.user_id == user_id,
                AffiliateAccount.is_active.is_(True),
                AffiliatePlatform.platform_code == platform_code,
            )
            .all()
        )
        if not accounts:
            logger.warning("[CampaignLinkSync] 用户 %d 无平台 %s 的活跃账号", user_id, platform_code)
            return 0

        cached_count = 0
        for acct in accounts:
            token = MerchantPlatformSyncService._resolve_token(acct, platform_code)
            if not token:
                logger.warning("[CampaignLinkSync] 用户 %d 平台 %s 无有效 Token", user_id, platform_code)
                continue
            try:
                count = self._sync_platform(user_id, platform_code, token)
                cached_count += count
            except Exception as e:
                logger.error("[CampaignLinkSync] 用户 %d 平台 %s 同步异常: %s", user_id, platform_code, e)
        return cached_count

    def _sync_platform(self, user_id: int, platform_code: str, token: str) -> int:
        """全量分页拉取某平台所有 Joined 商家，写入缓存。"""
        cfg = PLATFORM_API_CONFIG.get(platform_code)
        if not cfg:
            return 0

        all_items = self._fetch_all_joined(cfg, platform_code, token)
        if not all_items:
            return 0

        now = datetime.utcnow()
        count = 0

        for raw in all_items:
            mid = self._extract_mid(raw, platform_code)
            if not mid:
                continue

            mapped = CampaignLinkService._map_campaign_response(raw, platform_code)
            support_regions_json = json.dumps(mapped.get("support_regions") or [], ensure_ascii=False)

            try:
                existing = (
                    self.db.query(CampaignLinkCache)
                    .filter(
                        CampaignLinkCache.user_id == user_id,
                        CampaignLinkCache.platform_code == platform_code,
                        CampaignLinkCache.merchant_id == mid,
                    )
                    .first()
                )

                if existing:
                    existing.campaign_link = mapped.get("campaign_link")
                    existing.short_link = mapped.get("short_link")
                    existing.smart_link = mapped.get("smart_link")
                    existing.site_url = mapped.get("site_url")
                    existing.merchant_name = mapped.get("merchant_name")
                    existing.support_regions = support_regions_json
                    existing.categories = json.dumps(mapped.get("categories") or "", ensure_ascii=False) if mapped.get("categories") else None
                    existing.commission_rate = mapped.get("commission_rate")
                    existing.logo = mapped.get("logo")
                    existing.synced_at = now
                else:
                    record = CampaignLinkCache(
                        user_id=user_id,
                        platform_code=platform_code,
                        merchant_id=mid,
                        campaign_link=mapped.get("campaign_link"),
                        short_link=mapped.get("short_link"),
                        smart_link=mapped.get("smart_link"),
                        site_url=mapped.get("site_url"),
                        merchant_name=mapped.get("merchant_name"),
                        support_regions=support_regions_json,
                        categories=json.dumps(mapped.get("categories") or "", ensure_ascii=False) if mapped.get("categories") else None,
                        commission_rate=mapped.get("commission_rate"),
                        logo=mapped.get("logo"),
                        synced_at=now,
                    )
                    self.db.add(record)

                count += 1
                if count % 200 == 0:
                    self.db.commit()
                    time.sleep(0.1)  # 让出 SQLite 锁
            except Exception as e:
                logger.warning("[CampaignLinkSync] 写入缓存异常 mid=%s: %s", mid, e)
                try:
                    self.db.rollback()
                except Exception:
                    pass

        try:
            self.db.commit()
        except Exception as e:
            logger.warning("[CampaignLinkSync] 最终提交异常: %s", e)
            self.db.rollback()
        return count

    def _fetch_all_joined(self, cfg: dict, platform_code: str, token: str) -> List[dict]:
        """全量分页拉取 Joined 商家（处理 2000~8000 条数据）。
        
        增强：每页最多重试 3 次，用实际返回数量判断是否还有下一页。
        """
        mode = cfg["mode"]
        url = cfg["url"]
        page_key = cfg["page_key"]
        size_key = cfg["size_key"]
        max_size = cfg["max_size"]
        rate_sleep = cfg.get("rate_limit_sleep", 0.5)

        result: List[dict] = []
        page = 1
        max_retries = 3
        consecutive_empty = 0

        while True:
            items = None
            for attempt in range(1, max_retries + 1):
                try:
                    data = self._api_call(mode, url, platform_code, token, "Joined",
                                          page, max_size, page_key, size_key, cfg)
                    items = MerchantPlatformSyncService._extract_items(data)
                    break  # 成功
                except Exception as exc:
                    logger.warning("[CampaignLinkSync] %s page %d attempt %d/%d 失败: %s",
                                   platform_code, page, attempt, max_retries, exc)
                    if attempt < max_retries:
                        time.sleep(2 * attempt)  # 递增等待

            if items is None:
                logger.error("[CampaignLinkSync] %s page %d 全部 %d 次重试失败，跳过后续页",
                             platform_code, page, max_retries)
                break

            if not items:
                consecutive_empty += 1
                if consecutive_empty >= 2:
                    break  # 连续 2 页空数据，停止
                page += 1
                time.sleep(rate_sleep)
                continue

            consecutive_empty = 0
            result.extend(items)
            logger.info("[CampaignLinkSync] %s page %d: %d 条 (累计 %d)", platform_code, page, len(items), len(result))

            if len(items) < max_size:
                break
            page += 1
            time.sleep(rate_sleep)

        return result

    def _api_call(self, mode: str, url: str, platform_code: str, token: str,
                  relationship: str, page: int, per_page: int,
                  page_key: str, size_key: str, cfg: dict) -> dict:
        """复用 merchant_platform_sync 的 API 调用逻辑。"""
        if mode == "post_json":
            payload = {
                "source": cfg.get("source", ""),
                "token": token,
                page_key: page,
                size_key: per_page,
                "relationship": relationship,
            }
            resp = httpx.post(url, json=payload, timeout=_TIMEOUT)
        elif mode == "post_form":
            form_data = {
                "token": token,
                page_key: str(page),
                size_key: str(per_page),
            }
            if not cfg.get("skip_relationship_filter"):
                form_data["relationship"] = relationship
            resp = httpx.post(url, data=form_data, timeout=_TIMEOUT)
        elif mode in ("get", "get_post"):
            params = {
                "token": token,
                page_key: str(page),
                size_key: str(per_page),
            }
            # LH 不支持 relationship 过滤
            if not cfg.get("skip_relationship_filter"):
                params["relationship"] = relationship
            # 额外参数（如 LB 的 type=json）
            if cfg.get("extra_params"):
                params.update(cfg["extra_params"])
            resp = httpx.get(url, params=params, timeout=_TIMEOUT)
        else:
            raise ValueError(f"Unknown mode: {mode}")

        resp.raise_for_status()
        return resp.json()

    @staticmethod
    def _extract_mid(raw: dict, platform_code: str) -> Optional[str]:
        """从原始数据中提取 MID。优先 brand_id（CG/PM/BSH 推荐），回退 mid/mcid/id。"""
        for key in ("brand_id", "brandId", "mid", "mcid", "id"):
            val = raw.get(key)
            if val is not None and str(val).strip():
                return str(val).strip()
        return None
