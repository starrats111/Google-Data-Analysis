"""
关键词规划服务（CR-039）
使用 Google Ads KeywordPlanIdeaService 进行关键词研究。
"""
import logging
from typing import List, Dict, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.google_ads_api_data import GoogleAdsApiData, GoogleMccAccount
from app.services.google_ads_client_factory import create_google_ads_client

logger = logging.getLogger(__name__)


class KeywordPlanService:
    """关键词规划服务"""

    def __init__(self, db: Session):
        self.db = db

    def find_available_cid(self, mcc_id: int) -> dict:
        """查找 MCC 下的可用 CID（仅返回空闲的，busy 不返回）。

        CID 来源：MCC.child_customer_ids（同步时自动更新）。
        忙碌判定：该 CID 下任意广告系列最新记录 status == '已启用'。
        返回 {"customer_id": str|None, "all_cids": list(空闲), "busy_cids": list}
        """
        import json as _json

        mcc = self.db.query(GoogleMccAccount).filter(GoogleMccAccount.id == mcc_id).first()
        if not mcc:
            raise ValueError("MCC 账号不存在，请先在设置中添加 MCC")

        # 从存储的 child_customer_ids 获取 CID 列表
        all_cid_list = []
        if mcc.child_customer_ids:
            try:
                all_cid_list = _json.loads(mcc.child_customer_ids)
            except (ValueError, TypeError):
                pass

        if not all_cid_list:
            raise ValueError("该 MCC 尚无 CID 列表，请点击「刷新 CID」从 Google Ads 获取")

        # 查找 busy CID：在数据中心中有"已启用"广告系列的 CID
        from sqlalchemy import distinct as _distinct
        busy_set = set()
        for cid in all_cid_list:
            cid_clean = cid.replace("-", "")
            cid_variants = {cid, cid_clean}
            has_enabled = self.db.query(GoogleAdsApiData.campaign_id).filter(
                GoogleAdsApiData.mcc_id == mcc_id,
                GoogleAdsApiData.customer_id.in_(list(cid_variants)),
                GoogleAdsApiData.status == '已启用',
            ).order_by(GoogleAdsApiData.date.desc()).first()
            if has_enabled:
                busy_set.add(cid)

        free_cids = [c for c in all_cid_list if c not in busy_set]

        return {
            "customer_id": free_cids[0] if free_cids else None,
            "all_cids": free_cids,
            "busy_cids": list(busy_set),
            "total": len(all_cid_list),
        }

    def generate_keyword_ideas(
        self,
        mcc_id: int,
        customer_id: str,
        url: Optional[str] = None,
        keywords: Optional[List[str]] = None,
        language_id: str = "1000",
        geo_target: str = "2840",
        semrush_url: Optional[str] = None,
    ) -> List[Dict]:
        """通过 SemRush 获取关键词建议（主方案）。
        支持两种输入方式：
        1. url - 商家网址，自动查询 SemRush
        2. semrush_url - SemRush 链接，直接解析参数查询
        """
        from app.services.semrush_service import SemRushService

        svc = SemRushService()

        if semrush_url:
            parsed = SemRushService.parse_semrush_url(semrush_url)
            if parsed:
                logger.info(f"[KeywordPlan] 从 SemRush URL 解析: {parsed}")
                results = svc.get_organic_keywords(
                    parsed["domain"], parsed["database"], parsed["search_type"],
                )
                if results:
                    logger.info(f"[KeywordPlan] SemRush URL 返回 {len(results)} 个关键词")
                    return results

        if not url:
            raise ValueError("请提供商家网址或 SemRush 链接以进行关键词研究")

        geo_to_country = {"2840": "us", "2826": "uk", "2124": "ca", "2036": "au"}
        country = geo_to_country.get(geo_target, "us")

        results = svc.get_organic_keywords(url, country)
        if not results:
            raise ValueError(
                "未找到关键词。您可以：\n"
                "1. 尝试手动输入种子关键词\n"
                "2. 粘贴 SemRush 链接（如 https://sem.3ue.co/analytics/overview/?q=...）"
            )
        logger.info(f"[KeywordPlan] SemRush 返回 {len(results)} 个关键词 (url={url})")
        return results
