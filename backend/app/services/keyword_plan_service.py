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
        """查找 MCC 下的可用 CID，优先返回空闲的，全部繁忙时返回第一个。

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

        latest_date = self.db.query(func.max(GoogleAdsApiData.date)).filter(
            GoogleAdsApiData.mcc_id == mcc_id,
        ).scalar()

        if latest_date is None:
            return {
                "customer_id": all_cid_list[0],
                "all_cids": all_cid_list,
                "busy_cids": [],
            }

        busy_cids_q = self.db.query(GoogleAdsApiData.customer_id).filter(
            GoogleAdsApiData.mcc_id == mcc_id,
            GoogleAdsApiData.status == '已启用',
            GoogleAdsApiData.date == latest_date,
        ).distinct().all()
        busy_set = {c[0] for c in busy_cids_q if c[0]}

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
        language_id: str = "1000",  # English
        geo_target: str = "2840",  # US
    ) -> List[Dict]:
        """调用 KeywordPlanIdeaService 获取关键词建议。

        三种输入方式：
        - 只传 url → UrlSeed
        - 只传 keywords → KeywordSeed
        - 都传 → KeywordAndUrlSeed
        """
        mcc = self.db.query(GoogleMccAccount).filter(GoogleMccAccount.id == mcc_id).first()
        if not mcc:
            raise ValueError("MCC 账号不存在")

        client, mcc_customer_id = create_google_ads_client(mcc)
        keyword_plan_idea_service = client.get_service("KeywordPlanIdeaService")

        request = client.get_type("GenerateKeywordIdeasRequest")
        request.customer_id = customer_id.replace("-", "")
        request.language = f"languageConstants/{language_id}"
        request.geo_target_constants.append(f"geoTargetConstants/{geo_target}")

        # 设置种子
        if url and keywords:
            request.keyword_and_url_seed.url = url
            request.keyword_and_url_seed.keywords.extend(keywords[:10])
        elif url:
            request.url_seed.url = url
        elif keywords:
            request.keyword_seed.keywords.extend(keywords[:10])
        else:
            raise ValueError("至少需要提供 url 或 keywords")

        try:
            response = keyword_plan_idea_service.generate_keyword_ideas(request=request)
        except Exception as e:
            logger.error(f"[KeywordPlan] API 调用失败: {e}")
            raise ValueError(f"关键词研究失败: {str(e)}")

        results = []
        for idea in response.results:
            metrics = idea.keyword_idea_metrics
            results.append({
                "keyword": idea.text,
                "avg_monthly_searches": metrics.avg_monthly_searches or 0,
                "competition": metrics.competition.name if metrics.competition else "UNSPECIFIED",
                "competition_index": metrics.competition_index or 0,
                "low_top_of_page_bid": metrics.low_top_of_page_bid_micros / 1_000_000 if metrics.low_top_of_page_bid_micros else 0,
                "high_top_of_page_bid": metrics.high_top_of_page_bid_micros / 1_000_000 if metrics.high_top_of_page_bid_micros else 0,
            })

        # 按搜索量降序排列
        results.sort(key=lambda x: x["avg_monthly_searches"], reverse=True)
        logger.info(f"[KeywordPlan] 返回 {len(results)} 个关键词建议 (CID={customer_id})")
        return results
