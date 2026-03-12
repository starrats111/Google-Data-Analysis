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
    if current_user.role == 'manager':
        accounts = db.query(GoogleMccAccount).filter(
            GoogleMccAccount.is_active == True
        ).all()
    else:
        accounts = db.query(GoogleMccAccount).filter(
            GoogleMccAccount.user_id == current_user.id,
            GoogleMccAccount.is_active == True
        ).all()
    return [
        {
            "id": a.id,
            "mcc_id": a.mcc_id,
            "name": a.mcc_name or a.mcc_id,
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


# ─── AI 分析（Claude claude-opus-4-6） ───

class AiAnalysisRequest(BaseModel):
    items: List[dict] = Field(default_factory=list)
    question: str = ""


@router.post("/ai-analysis")
async def ai_analysis(
    data: AiAnalysisRequest,
    current_user: User = Depends(get_current_user),
):
    """测试看板 AI 分析 — 使用 Claude claude-opus-4-6 分析广告数据"""
    import json
    import requests
    from app.config import settings

    if not data.items:
        raise HTTPException(status_code=400, detail="没有数据可分析")

    # 构建数据摘要
    summary_lines = []
    for item in data.items:
        ad = item.get("ad_data") or {}
        line = (
            f"商家: {item.get('merchant_name', '?')}, "
            f"Campaign: {item.get('campaign_id', '?')}, "
            f"CID: {item.get('customer_id', '?')}, "
            f"日预算: ${item.get('daily_budget', 0)}, "
            f"国家: {item.get('target_country', '?')}, "
            f"花费: ${ad.get('cost', 0)}, "
            f"点击: {ad.get('clicks', 0)}, "
            f"展示: {ad.get('impressions', 0)}, "
            f"转化: {ad.get('conversions', 0)}, "
            f"状态: {ad.get('status', '未知')}, "
            f"同步中: {item.get('sync_pending', False)}"
        )
        summary_lines.append(line)

    data_text = "\n".join(summary_lines)
    user_question = data.question or "请分析这些测试广告的整体表现，给出优化建议"

    prompt = f"""你是一位资深的 Google Ads 广告优化专家。以下是用户的测试广告数据：

{data_text}

用户问题：{user_question}

请从以下维度分析：
1. 整体表现评估（CTR、CPC、转化率等关键指标）
2. 预算分配是否合理
3. 表现好的广告系列（值得加大投入）
4. 表现差的广告系列（需要优化或暂停）
5. 具体优化建议（出价、关键词、素材、投放地区等）
6. 下一步行动计划

请用中文回答，结构清晰，给出可执行的建议。如果数据还在同步中（sync_pending=True），请说明需要等数据同步后再做完整分析。"""

    messages = [{"role": "user", "content": prompt}]

    # 调用 Claude claude-opus-4-6（通过 OpenRouter 兼容 API）
    api_key = getattr(settings, "gemini_api_key", "")
    base_url = getattr(settings, "gemini_base_url", "").rstrip("/")
    model = "claude-opus-4-0-20250514"

    if not api_key or not base_url:
        raise HTTPException(status_code=500, detail="AI 服务未配置")

    try:
        resp = requests.post(
            f"{base_url}/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": messages,
                "max_tokens": 4096,
                "temperature": 0.3,
            },
            timeout=120,
        )
        resp.raise_for_status()
        result = resp.json()
        content = result["choices"][0]["message"]["content"]
        return {
            "analysis": content,
            "model": model,
            "items_analyzed": len(data.items),
        }
    except requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="AI 分析超时，请稍后重试")
    except Exception as e:
        logger.error(f"[AI Analysis] 失败: {e}")
        # fallback 到 deepseek-chat
        try:
            resp = requests.post(
                f"{base_url}/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "deepseek-chat",
                    "messages": messages,
                    "max_tokens": 4096,
                    "temperature": 0.3,
                },
                timeout=60,
            )
            resp.raise_for_status()
            result = resp.json()
            content = result["choices"][0]["message"]["content"]
            return {
                "analysis": content,
                "model": "deepseek-chat (fallback)",
                "items_analyzed": len(data.items),
            }
        except Exception as e2:
            logger.error(f"[AI Analysis] fallback 也失败: {e2}")
            raise HTTPException(status_code=500, detail=f"AI 分析失败: {str(e)[:200]}")
