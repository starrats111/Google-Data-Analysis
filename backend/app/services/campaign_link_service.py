"""
Campaign Link 获取服务（OPT-015）

从各联盟平台 Monetization API 自动获取 campaign links，
使用员工自己的 Token，并根据 Support Regions 自动判断语言。
"""
import logging
from typing import List, Optional

import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.services.merchant_platform_sync import (
    MerchantPlatformSyncService,
    PLATFORM_API_CONFIG,
)

logger = logging.getLogger(__name__)

REGION_LANGUAGE_MAP = {
    "US": ("English", "en"), "UK": ("English", "en"),
    "GB": ("English", "en"),
    "AU": ("English", "en"), "CA": ("English", "en"),
    "NZ": ("English", "en"), "IE": ("English", "en"),
    "SG": ("English", "en"), "PH": ("English", "en"),
    "JP": ("Japanese", "ja"), "KR": ("Korean", "ko"),
    "DE": ("German", "de"), "AT": ("German", "de"),
    "CH": ("German", "de"),
    "FR": ("French", "fr"), "BE": ("French", "fr"),
    "ES": ("Spanish", "es"), "MX": ("Spanish", "es"),
    "AR": ("Spanish", "es"), "CL": ("Spanish", "es"),
    "CO": ("Spanish", "es"),
    "IT": ("Italian", "it"),
    "PT": ("Portuguese", "pt"), "BR": ("Portuguese", "pt"),
    "RU": ("Russian", "ru"),
    "NL": ("Dutch", "nl"),
    "SE": ("Swedish", "sv"), "NO": ("Norwegian", "no"),
    "DK": ("Danish", "da"), "FI": ("Finnish", "fi"),
    "PL": ("Polish", "pl"), "CZ": ("Czech", "cs"),
    "TR": ("Turkish", "tr"),
    "TH": ("Thai", "th"), "VN": ("Vietnamese", "vi"),
    "ID": ("Indonesian", "id"), "MY": ("Malay", "ms"),
    "TW": ("Traditional Chinese", "zh-tw"),
    "HK": ("Traditional Chinese", "zh-tw"),
    "CN": ("Simplified Chinese", "zh"),
    "SA": ("Arabic", "ar"), "AE": ("Arabic", "ar"),
    "EG": ("Arabic", "ar"),
    "IN": ("English", "en"), "IL": ("Hebrew", "he"),
}


class CampaignLinkService:

    def __init__(self, db: Session):
        self.db = db

    def get_user_platforms(self, user_id: int) -> List[dict]:
        """获取用户有活跃账号的平台列表（去重）。"""
        accounts = (
            self.db.query(AffiliateAccount)
            .join(AffiliatePlatform)
            .filter(
                AffiliateAccount.user_id == user_id,
                AffiliateAccount.is_active.is_(True),
            )
            .all()
        )
        seen = set()
        result = []
        for acct in accounts:
            code = acct.platform.platform_code.upper()
            if code not in seen:
                seen.add(code)
                result.append({
                    "platform_code": code,
                    "platform_name": acct.platform.platform_name,
                })
        return result

    def get_campaign_link(self, user_id: int, platform_code: str, merchant_id: str) -> dict:
        """根据员工的平台账号 Token 获取指定商家的 campaign link。"""
        platform_code = platform_code.upper()

        account = (
            self.db.query(AffiliateAccount)
            .join(AffiliatePlatform)
            .filter(
                AffiliateAccount.user_id == user_id,
                AffiliatePlatform.platform_code == platform_code,
                AffiliateAccount.is_active.is_(True),
            )
            .first()
        )
        if not account:
            raise HTTPException(400, "你没有该平台的账号，请联系管理员")

        token = MerchantPlatformSyncService._resolve_token(account, platform_code)
        if not token:
            raise HTTPException(400, "Token 无效，请更新平台账号凭证")

        raw = self._fetch_merchant_by_id(platform_code, token, merchant_id)
        if not raw:
            raise HTTPException(404, "未找到该 MID 对应的商家")

        return self._map_campaign_response(raw, platform_code)

    def _fetch_merchant_by_id(self, platform_code: str, token: str, merchant_id: str) -> Optional[dict]:
        """调用 Monetization API 查询指定 MID 的商家详情（含 campaign link）。"""
        cfg = PLATFORM_API_CONFIG.get(platform_code)
        if not cfg:
            raise HTTPException(400, "该平台暂不支持自动获取 Campaign Link")

        mode = cfg["mode"]
        url = cfg["url"]
        timeout = httpx.Timeout(30.0, connect=10.0)

        try:
            if mode == "post_json":
                payload = {
                    "source": cfg.get("source", ""),
                    "token": token,
                    "brand_id": merchant_id,
                }
                resp = httpx.post(url, json=payload, timeout=timeout)
            elif mode in ("get", "get_post"):
                params = {
                    "token": token,
                    "mcid": merchant_id,
                }
                resp = httpx.get(url, params=params, timeout=timeout)
            elif mode == "post_form":
                form_data = {
                    "token": token,
                    "mcid": merchant_id,
                }
                resp = httpx.post(url, data=form_data, timeout=timeout)
            else:
                raise HTTPException(400, f"不支持的 API 模式: {mode}")

            resp.raise_for_status()
            data = resp.json()
        except httpx.HTTPStatusError as exc:
            logger.error("Campaign link API error for %s: %s", platform_code, exc)
            raise HTTPException(502, f"平台 API 返回错误: {exc.response.status_code}")
        except httpx.RequestError as exc:
            logger.error("Campaign link API request failed for %s: %s", platform_code, exc)
            raise HTTPException(502, "平台 API 请求失败，请稍后重试")

        items = MerchantPlatformSyncService._extract_items(data)
        return items[0] if items else None

    @staticmethod
    def _map_campaign_response(raw: dict, platform_code: str) -> dict:
        """将平台原始响应映射为统一的 campaign link 结果。"""
        campaign_link = (
            raw.get("campaign_link")
            or raw.get("tracking_link")
            or raw.get("aff_link")
            or raw.get("tracking_url")
        )

        raw_regions = raw.get("support_region") or raw.get("support_regions") or []
        if isinstance(raw_regions, str):
            raw_regions = [r.strip() for r in raw_regions.split(",")]

        support_regions = []
        for r in raw_regions:
            code = r.upper() if isinstance(r, str) else str(r)
            lang_info = REGION_LANGUAGE_MAP.get(code, ("English", "en"))
            support_regions.append({
                "code": code,
                "language": lang_info[0],
                "language_code": lang_info[1],
            })

        return {
            "campaign_link": campaign_link,
            "site_url": raw.get("site_url") or raw.get("siteUrl"),
            "merchant_name": raw.get("merchant_name") or raw.get("merchantName"),
            "support_regions": support_regions,
            "categories": raw.get("categories"),
            "commission_rate": raw.get("comm_rate") or raw.get("commRate"),
            "logo": raw.get("logo"),
        }

    @staticmethod
    def detect_language(region_code: str) -> dict:
        """根据区域代码自动判断语言。"""
        region = region_code.upper()
        if region in REGION_LANGUAGE_MAP:
            name, code = REGION_LANGUAGE_MAP[region]
            return {"language": name, "code": code}
        return {"language": "English", "code": "en"}
