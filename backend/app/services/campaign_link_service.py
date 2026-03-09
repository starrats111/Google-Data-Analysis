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
        """获取当前用户自己有活跃账号的平台列表。
        
        每个人的 campaign link 不同（tracking 归属不同），
        只能用自己的 Token 获取，因此只返回自己有账号的平台。
        """
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
        """根据当前员工自己的 Token 获取指定商家的 campaign link。
        
        每个人的 campaign link 不同（tracking 归属不同），必须用自己的 Token。
        """
        platform_code = platform_code.upper()
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
            raise HTTPException(400, "你没有该平台的账号，请先在联盟账号管理中添加")

        token = MerchantPlatformSyncService._resolve_token(account, platform_code)
        if not token:
            raise HTTPException(400, "Token 无效，请更新平台账号凭证")

        raw = self._fetch_merchant_by_id(platform_code, token, merchant_id)
        if not raw:
            raise HTTPException(404, "未在你的账号中找到该商家，可能未加入该商家计划，请手动输入追踪链接")

        return self._map_campaign_response(raw, platform_code)

    def _fetch_merchant_by_id(self, platform_code: str, token: str, merchant_id: str) -> Optional[dict]:
        """调用 Monetization API 查询指定商家（含 campaign link）。
        优化：mid 精确查 → 分页遍历最多 1 页兜底，超时 25s。
        """
        cfg = PLATFORM_API_CONFIG.get(platform_code)
        if not cfg:
            raise HTTPException(400, f"不支持的平台: {platform_code}")

        mode = cfg["mode"]
        url = cfg["url"]
        timeout = httpx.Timeout(25.0, connect=10.0)

        try:
            if mode == "post_json":
                # 精确查询
                payload = {
                    "source": cfg.get("source", ""),
                    "token": token, "curPage": 1, "perPage": 100,
                    "relationship": "Joined", "mid": merchant_id,
                }
                try:
                    resp = httpx.post(url, json=payload, timeout=timeout)
                    resp.raise_for_status()
                    items = MerchantPlatformSyncService._extract_items(resp.json())
                    if items:
                        found = self._match_merchant(items, merchant_id, platform_code)
                        if found:
                            return found
                        logger.warning(f"[CampaignLink] 精确查询返回 {len(items)} 条但未匹配 mid={merchant_id}")
                    else:
                        logger.info(f"[CampaignLink] 精确查询无结果，尝试兜底遍历 mid={merchant_id}")
                except Exception as e:
                    logger.warning(f"[CampaignLink] 精确查询异常: {e}，尝试兜底遍历")

                # 分页遍历兜底（仅 1 页，减少等待）
                payload = {
                    "source": cfg.get("source", ""),
                    "token": token, "curPage": 1, "perPage": 2000,
                    "relationship": "Joined",
                }
                try:
                    resp = httpx.post(url, json=payload, timeout=timeout)
                    resp.raise_for_status()
                    items = MerchantPlatformSyncService._extract_items(resp.json())
                    if items:
                        found = self._match_merchant(items, merchant_id, platform_code)
                        if found:
                            return found
                        logger.warning(f"[CampaignLink] 兜底遍历 {len(items)} 条仍未匹配 mid={merchant_id}")
                except Exception as e:
                    logger.warning(f"[CampaignLink] 兜底遍历异常: {e}")
                return None

            elif platform_code == "LB":
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
                params = {"token": token, "page": "1", "per_page": "100"}
                if merchant_id.isdigit():
                    params["mcid"] = merchant_id
                resp = httpx.get(url, params=params, timeout=timeout)
                resp.raise_for_status()
                items = MerchantPlatformSyncService._extract_items(resp.json())
                return self._match_merchant(items, merchant_id, platform_code) if items else None

            elif mode == "post_form":
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

        except HTTPException:
            raise
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status in (502, 503, 504):
                raise HTTPException(502, f"平台 {platform_code} 暂时不可用，请稍后重试")
            raise HTTPException(502, f"平台 API 返回错误: {status}")
        except httpx.RequestError:
            raise HTTPException(502, f"平台 {platform_code} 请求超时，请稍后重试")

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
