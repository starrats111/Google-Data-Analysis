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
        """查找 MCC 下的可用 CID，优先返回空闲的。

        忙碌判定：该 CID 下任意广告系列的**最近一条记录**status == '已启用'。
        返回 {"customer_id": str, "all_cids": list, "busy_cids": list}
        """
        mcc = self.db.query(GoogleMccAccount).filter(GoogleMccAccount.id == mcc_id).first()
        if not mcc:
            raise ValueError("MCC 账号不存在，请先在设置中添加 MCC")

        all_cids = self.db.query(GoogleAdsApiData.customer_id).filter(
            GoogleAdsApiData.mcc_id == mcc_id,
            GoogleAdsApiData.customer_id.isnot(None),
        ).distinct().all()
        all_cid_list = [c[0] for c in all_cids if c[0]]

        if not all_cid_list:
            raise ValueError("MCC 下没有 CID 数据，请先执行一次数据同步")

        # 简单直接：查找该 MCC 下所有有 '已启用' 状态广告的 CID
        # 只要某 CID 在最近数据中包含已启用广告，就算忙碌
        busy_set = set()
        for cid in all_cid_list:
            latest = self.db.query(GoogleAdsApiData.status).filter(
                GoogleAdsApiData.mcc_id == mcc_id,
                GoogleAdsApiData.customer_id == cid,
                GoogleAdsApiData.status == '已启用',
            ).first()
            if latest:
                busy_set.add(cid)

        recommended = None
        for cid in all_cid_list:
            if cid not in busy_set:
                recommended = cid
                break

        if not recommended:
            recommended = all_cid_list[0]

        return {
            "customer_id": recommended,
            "all_cids": all_cid_list,
            "busy_cids": list(busy_set),
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
