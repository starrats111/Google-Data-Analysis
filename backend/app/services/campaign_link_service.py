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
        """获取用户有活跃账号的平台列表，如果用户自己没有则返回团队可用平台。"""
        from sqlalchemy import func

        # 先查用户自己的
        accounts = (
            self.db.query(AffiliateAccount)
            .join(AffiliatePlatform)
            .filter(
                AffiliateAccount.user_id == user_id,
                AffiliateAccount.is_active.is_(True),
            )
            .all()
        )

        # 如果用户自己没有账号，查所有活跃账号的平台
        if not accounts:
            accounts = (
                self.db.query(AffiliateAccount)
                .join(AffiliatePlatform)
                .filter(AffiliateAccount.is_active.is_(True))
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

        # 查找用户在该平台的活跃账号（大小写不敏感匹配 platform_code）
        from sqlalchemy import func
        account = (
            self.db.query(AffiliateAccount)
            .join(AffiliatePlatform)
            .filter(
                AffiliateAccount.user_id == user_id,
                func.upper(AffiliatePlatform.platform_code) == platform_code,
                AffiliateAccount.is_active.is_(True),
            )
            .first()
        )
        if not account:
            # 回退：尝试用团队内任意可用账号
            account = (
                self.db.query(AffiliateAccount)
                .join(AffiliatePlatform)
                .filter(
                    func.upper(AffiliatePlatform.platform_code) == platform_code,
                    AffiliateAccount.is_active.is_(True),
                )
                .first()
            )
        if not account:
            raise HTTPException(400, "该平台没有可用的账号，请联系管理员")

        token = MerchantPlatformSyncService._resolve_token(account, platform_code)
        if not token:
            raise HTTPException(400, "Token 无效，请更新平台账号凭证")

        raw = self._fetch_merchant_by_id(platform_code, token, merchant_id)
        if not raw:
            raise HTTPException(404, "未找到该 MID 对应的商家")

        return self._map_campaign_response(raw, platform_code)

    def _fetch_merchant_by_id(self, platform_code: str, token: str, merchant_id: str) -> Optional[dict]:
        """调用 Monetization API 查询指定商家详情（含 campaign link）。

        策略：
        - LB: 支持 mid/mcid 过滤参数，直接精确查询
        - CF/CG/BSH/PM: 不支持按 MID 过滤，需分页遍历查找（限制最多 5 页）
        - LH: 按 mcid 过滤
        - RW: 按 mid/mcid 过滤
        """
        cfg = PLATFORM_API_CONFIG.get(platform_code)
        if not cfg:
            raise HTTPException(400, "该平台暂不支持自动获取 Campaign Link")

        mode = cfg["mode"]
        url = cfg["url"]
        timeout = httpx.Timeout(60.0, connect=15.0)
        max_pages = 10  # 最多翻 10 页防止无限循环

        try:
            if mode == "post_json":
                # CF / CG / BSH / PM — 不支持按 MID 过滤，需分页遍历
                actual_total_pages = max_pages
                for page in range(1, max_pages + 1):
                    payload = {
                        "source": cfg.get("source", ""),
                        "token": token,
                        "curPage": page,
                        "perPage": 2000,
                        "relationship": "Joined",
                    }
                    try:
                        resp = httpx.post(url, json=payload, timeout=timeout)
                        resp.raise_for_status()
                    except (httpx.HTTPStatusError, httpx.RequestError) as page_err:
                        logger.warning("Campaign link %s page %d failed: %s", platform_code, page, page_err)
                        break
                    data = resp.json()

                    # 利用 API 返回的 total_page 动态调整
                    if page == 1:
                        resp_data = data.get("data", data) if isinstance(data, dict) else {}
                        tp = resp_data.get("total_page") or resp_data.get("totalPage")
                        if tp and isinstance(tp, int) and tp > 0:
                            actual_total_pages = min(tp, 50)  # 安全上限 50 页
                            logger.info("[CampaignLink] %s total_page=%d, will scan up to %d", platform_code, tp, actual_total_pages)

                    items = MerchantPlatformSyncService._extract_items(data)
                    if not items:
                        break

                    found = self._match_merchant(items, merchant_id, platform_code)
                    if found:
                        return found

                    if len(items) < 2000 or page >= actual_total_pages:
                        break
                return None

            elif platform_code == "LB":
                # LB 支持 mid 和 mcid 作为过滤参数
                params = {"token": token, "limit": "10"}
                if merchant_id.isdigit():
                    params["mid"] = merchant_id
                else:
                    params["mcid"] = merchant_id
                resp = httpx.get(url, params=params, timeout=timeout)
                resp.raise_for_status()
                items = MerchantPlatformSyncService._extract_items(resp.json())
                return self._match_merchant(items, merchant_id, platform_code) if items else None

            elif platform_code == "LH":
                # LH — mcid 是数字 ID
                params = {
                    "token": token,
                    "page": "1",
                    "per_page": "100",
                }
                if merchant_id.isdigit():
                    params["mcid"] = merchant_id
                resp = httpx.get(url, params=params, timeout=timeout)
                resp.raise_for_status()
                items = MerchantPlatformSyncService._extract_items(resp.json())
                return self._match_merchant(items, merchant_id, platform_code) if items else None

            elif mode == "post_form":
                # RW — 支持 mid/mcid 过滤
                form_data = {"token": token, "page": "1", "limit": "10"}
                if merchant_id.isdigit():
                    form_data["mid"] = merchant_id
                else:
                    form_data["mcid"] = merchant_id
                resp = httpx.post(url, data=form_data, timeout=timeout)
                resp.raise_for_status()
                items = MerchantPlatformSyncService._extract_items(resp.json())
                return self._match_merchant(items, merchant_id, platform_code) if items else None

            else:
                raise HTTPException(400, f"不支持的 API 模式: {mode}")

        except httpx.HTTPStatusError as exc:
            logger.error("Campaign link API error for %s: %s", platform_code, exc)
            status = exc.response.status_code
            if status in (502, 503, 504):
                raise HTTPException(502, f"平台 {platform_code} API 暂时不可用（{status}），请稍后重试")
            raise HTTPException(502, f"平台 API 返回错误: {status}")
        except httpx.RequestError as exc:
            logger.error("Campaign link API request failed for %s: %s", platform_code, exc)
            raise HTTPException(502, f"平台 {platform_code} API 请求超时，请稍后重试")

    @staticmethod
    def _match_merchant(items: list, merchant_id: str, platform_code: str) -> Optional[dict]:
        """从返回列表中精确匹配目标商家"""
        mid_lower = merchant_id.lower().strip()
        for item in items:
            candidates = [
                str(item.get("mid") or "").strip(),
                str(item.get("brand_id") or "").strip(),
                str(item.get("brandId") or "").strip(),
                str(item.get("mcid") or "").strip(),
                str(item.get("id") or "").strip(),
            ]
            if merchant_id in candidates or mid_lower in [c.lower() for c in candidates]:
                return item
        return None

    @staticmethod
    def _map_campaign_response(raw: dict, platform_code: str) -> dict:
        """将平台原始响应映射为统一的 campaign link 结果。"""
        # 各平台 tracking link 字段名统一提取
        campaign_link = (
            raw.get("tracking_url")          # CF/CG/BSH/LH/LB/RW 通用
            or raw.get("trackingUrl")         # PM (camelCase)
            or raw.get("campaign_link")
            or raw.get("tracking_link")
            or raw.get("aff_link")
        )

        # 短链接
        short_link = raw.get("tracking_url_short") or raw.get("trackingUrlShort")
        smart_link = raw.get("tracking_url_smart") or raw.get("trackingUrlSmart")

        raw_regions = raw.get("support_region") or raw.get("supportRegion") or raw.get("support_regions") or []
        if isinstance(raw_regions, str):
            raw_regions = [r.strip() for r in raw_regions.split(",") if r.strip()]

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
            "short_link": short_link,
            "smart_link": smart_link,
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
