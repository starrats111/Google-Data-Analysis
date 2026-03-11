"""
广告创建 API（CR-039）
提供关键词研究、AI 素材生成、广告创建的完整流程端点。
"""
import logging
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.google_ads_api_data import GoogleMccAccount, GoogleAdsApiData
from app.models.merchant import MerchantAssignment

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/ad-creation", tags=["广告创建"])


# ─── 请求模型 ───

class FindCidRequest(BaseModel):
    mcc_id: int


class KeywordRequest(BaseModel):
    mcc_id: int
    customer_id: str
    url: Optional[str] = None
    keywords: Optional[List[str]] = None
    language_id: str = "1000"
    geo_target: str = "2840"


class AdCopyRequest(BaseModel):
    merchant_name: str
    merchant_url: str = ""
    keywords: List[dict] = Field(default_factory=list)
    category: str = ""
    language: str = "en"


class CreateAdRequest(BaseModel):
    assignment_id: int
    mcc_id: int
    customer_id: str
    merchant_name: str
    merchant_url: str = ""
    keywords: List[str] = Field(default_factory=list)
    headlines: List[str] = Field(default_factory=list)
    descriptions: List[str] = Field(default_factory=list)
    daily_budget: float = 10.0
    target_country: str = "US"
    mode: str = "test"


# ─── 端点 ───

@router.get("/mcc-accounts")
async def list_mcc_accounts(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取当前用户的 MCC 账号列表（M-47: Step 0 选择 MCC）"""
    accounts = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.user_id == current_user.id
    ).all()
    return [
        {
            "id": a.id,
            "mcc_id": a.mcc_id,
            "name": getattr(a, "name", "") or a.mcc_id,
        }
        for a in accounts
    ]


@router.post("/find-available-cid")
async def find_available_cid(
    data: FindCidRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """查找空闲 CID（零 API 消耗）"""
    from app.services.keyword_plan_service import KeywordPlanService
    svc = KeywordPlanService(db)
    try:
        cid = svc.find_available_cid(data.mcc_id)
        return {"customer_id": cid}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/keyword-ideas")
async def generate_keyword_ideas(
    data: KeywordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """关键词研究（1 次 API 调用）"""
    from app.services.keyword_plan_service import KeywordPlanService
    svc = KeywordPlanService(db)
    try:
        results = svc.generate_keyword_ideas(
            mcc_id=data.mcc_id,
            customer_id=data.customer_id,
            url=data.url,
            keywords=data.keywords,
            language_id=data.language_id,
            geo_target=data.geo_target,
        )
        return {"keywords": results, "count": len(results)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/generate-ad-copy")
async def generate_ad_copy(
    data: AdCopyRequest,
    current_user: User = Depends(get_current_user),
):
    """AI 生成广告素材"""
    from app.services.ad_copy_generator import ad_copy_generator
    try:
        result = ad_copy_generator.generate_ad_copy(
            merchant_name=data.merchant_name,
            merchant_url=data.merchant_url,
            keywords=data.keywords,
            category=data.category,
            language=data.language,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/create-campaign")
async def create_campaign(
    data: CreateAdRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """创建完整广告（1 次 API 调用，打包 Mutate）"""
    # 验证 assignment 归属
    assignment = db.query(MerchantAssignment).filter(
        MerchantAssignment.id == data.assignment_id,
        MerchantAssignment.user_id == current_user.id,
    ).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="分配记录不存在或不属于你")

    # 幂等性检查：该 assignment 是否已有广告
    if assignment.google_campaign_id:
        return {
            "success": True,
            "campaign_id": assignment.google_campaign_id,
            "message": "该商家已创建过广告",
            "is_existing": True,
        }

    from app.services.google_ads_creator import GoogleAdsCreator
    creator = GoogleAdsCreator(db)
    try:
        result = creator.create_full_campaign(
            mcc_id=data.mcc_id,
            customer_id=data.customer_id,
            merchant_name=data.merchant_name,
            keywords=data.keywords,
            headlines=data.headlines,
            descriptions=data.descriptions,
            daily_budget=data.daily_budget,
            target_country=data.target_country,
            mode=data.mode,
            final_url=data.merchant_url,
        )

        # 更新 assignment 记录
        assignment.google_campaign_id = result.get("campaign_id")
        assignment.google_customer_id = data.customer_id
        assignment.daily_budget = data.daily_budget
        assignment.target_country = data.target_country
        assignment.mode = data.mode
        db.commit()

        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/test-dashboard")
async def get_test_dashboard(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """测试商家看板 — 只展示广告侧数据（M-50 闭环）"""
    # 查找当前用户的测试模式分配
    test_assignments = db.query(MerchantAssignment).filter(
        MerchantAssignment.user_id == current_user.id,
        MerchantAssignment.mode == "test",
        MerchantAssignment.status == "active",
    ).all()

    results = []
    for a in test_assignments:
        merchant = a.merchant
        ad_data = None
        sync_pending = False

        if a.google_customer_id and a.google_campaign_id:
            # 查找广告数据
            ad_data = db.query(GoogleAdsApiData).filter(
                GoogleAdsApiData.user_id == current_user.id,
                GoogleAdsApiData.customer_id == a.google_customer_id,
                GoogleAdsApiData.campaign_id == a.google_campaign_id,
            ).order_by(GoogleAdsApiData.date.desc()).first()

            if not ad_data:
                sync_pending = True

        results.append({
            "assignment_id": a.id,
            "merchant_name": merchant.merchant_name if merchant else "Unknown",
            "merchant_id": a.merchant_id,
            "campaign_id": a.google_campaign_id,
            "customer_id": a.google_customer_id,
            "daily_budget": float(a.daily_budget) if a.daily_budget else 0,
            "target_country": a.target_country,
            "created_at": a.created_at.isoformat() if a.created_at else None,
            "sync_pending": sync_pending,
            "ad_data": {
                "cost": float(ad_data.cost or 0) if ad_data else 0,
                "clicks": ad_data.clicks or 0 if ad_data else 0,
                "impressions": ad_data.impressions or 0 if ad_data else 0,
                "conversions": float(ad_data.conversions or 0) if ad_data else 0,
                "status": ad_data.status if ad_data else "未同步",
                "date": ad_data.date.isoformat() if ad_data and ad_data.date else None,
            } if ad_data or sync_pending else None,
        })

    return {"items": results, "total": len(results)}
