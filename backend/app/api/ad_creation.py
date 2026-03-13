"""
广告创建 API（CR-039 / CR-048）
提供关键词研究、AI 素材生成（含 SSE 流式）、广告创建的完整流程端点。
"""
import json
import logging
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.google_ads_api_data import GoogleMccAccount, GoogleAdsApiData
from app.models.merchant import MerchantAssignment, AffiliateMerchant
from app.models.campaign_link_cache import CampaignLinkCache

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
    semrush_url: Optional[str] = None


class AdCopyRequest(BaseModel):
    merchant_name: str
    merchant_url: str = ""
    keywords: List[dict] = Field(default_factory=list)
    category: str = ""
    language: str = "en"
    target_country: str = "US"
    mcc_id: Optional[int] = None


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


@router.get("/assignment-detail/{assignment_id}")
async def get_assignment_detail(
    assignment_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """根据分配 ID 获取商家网址等详情，用于广告向导自动填入"""
    assignment = db.query(MerchantAssignment).filter(
        MerchantAssignment.id == assignment_id,
        MerchantAssignment.user_id == current_user.id,
    ).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="分配记录不存在或不属于你")

    merchant = assignment.merchant
    if not merchant:
        raise HTTPException(status_code=404, detail="商家不存在")

    site_url = ""
    if merchant.merchant_id:
        cache = db.query(CampaignLinkCache).filter(
            CampaignLinkCache.platform_code == merchant.platform,
            CampaignLinkCache.merchant_id == merchant.merchant_id,
        ).first()
        if cache and cache.site_url:
            site_url = cache.site_url

    return {
        "merchant_name": merchant.merchant_name,
        "platform": merchant.platform,
        "site_url": site_url,
        "target_country": assignment.target_country or "US",
        "mode": assignment.mode or "normal",
    }


@router.post("/find-available-cid")
async def find_available_cid(
    data: FindCidRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """查找可用 CID，返回推荐CID和全部CID列表"""
    from app.services.keyword_plan_service import KeywordPlanService
    svc = KeywordPlanService(db)
    try:
        result = svc.find_available_cid(data.mcc_id)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/keyword-ideas")
async def generate_keyword_ideas(
    data: KeywordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """关键词研究 — 支持商家 URL 或 SemRush 链接"""
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
            semrush_url=data.semrush_url,
        )
        return {"keywords": results, "count": len(results)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/generate-ad-copy")
async def generate_ad_copy(
    data: AdCopyRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """AI 生成广告素材（非流式，兼容旧版）"""
    from app.services.ad_copy_generator import ad_copy_generator, analyze_user_campaigns
    history = None
    if data.mcc_id:
        try:
            history = analyze_user_campaigns(current_user.id, data.mcc_id, db)
        except Exception as e:
            logger.warning(f"[AdCopy] 历史分析失败: {e}")
    try:
        result = ad_copy_generator.generate_ad_copy(
            merchant_name=data.merchant_name,
            merchant_url=data.merchant_url,
            keywords=data.keywords,
            category=data.category,
            target_country=data.target_country,
            history=history,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/generate-ad-copy-stream")
async def generate_ad_copy_stream(
    data: AdCopyRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """AI 生成广告素材（SSE 流式输出思考过程）"""
    from app.services.ad_copy_generator import ad_copy_generator, analyze_user_campaigns, COUNTRY_LANGUAGE_MAP

    history = None
    history_summary = ""
    if data.mcc_id:
        try:
            history = analyze_user_campaigns(current_user.id, data.mcc_id, db)
            if history and history["has_data"]:
                history_summary = f"已分析 {history['total_campaigns']} 个广告系列"
                if history["top_campaigns"]:
                    best = history["top_campaigns"][0]
                    history_summary += f"，最佳广告「{best['campaign_name']}」CTR={best['ctr']}%"
        except Exception as e:
            logger.warning(f"[AdCopy] 历史分析失败: {e}")

    country_info = COUNTRY_LANGUAGE_MAP.get(data.target_country, COUNTRY_LANGUAGE_MAP["US"])

    def event_stream():
        sse = lambda d: f"data: {json.dumps(d, ensure_ascii=False)}\n\n"

        yield sse({"phase": "analyzing", "text": f"正在加载历史数据...\n"})

        if history_summary:
            yield sse({"phase": "history", "text": f"✓ {history_summary}\n"})
        else:
            yield sse({"phase": "history", "text": "✓ 基于行业经验生成\n"})

        yield sse({
            "phase": "thinking_start",
            "text": f"✓ 目标: {country_info['name']}（{country_info['language']}）\n⚡ 正在为「{data.merchant_name}」生成广告文案...\n\n",
        })

        try:
            for chunk in ad_copy_generator.generate_ad_copy_stream(
                merchant_name=data.merchant_name,
                merchant_url=data.merchant_url,
                keywords=data.keywords,
                target_country=data.target_country,
                history=history,
                category=data.category,
            ):
                if chunk.startswith("<<FINAL_JSON>>"):
                    result = json.loads(chunk[14:])
                    yield sse({"phase": "done", "result": result})
                elif chunk.startswith("<<ERROR>>"):
                    yield sse({"phase": "error", "text": chunk[9:]})
                else:
                    yield sse({"phase": "thinking", "text": chunk})
        except Exception as e:
            logger.error(f"[AdCopy Stream] 失败: {e}")
            yield sse({"phase": "error", "text": str(e)})

    return StreamingResponse(event_stream(), media_type="text/event-stream")


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
        merchant = assignment.merchant
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
            platform=merchant.platform if merchant else "",
            merchant_mid=merchant.merchant_id if merchant else "",
            assignment_id=data.assignment_id,
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


@router.delete("/campaign/{assignment_id}")
async def delete_campaign(
    assignment_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """删除广告系列：Google Ads 中移除 + 清除本地记录"""
    assignment = db.query(MerchantAssignment).filter(
        MerchantAssignment.id == assignment_id,
        MerchantAssignment.user_id == current_user.id,
    ).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="分配记录不存在或不属于你")

    campaign_id = assignment.google_campaign_id
    customer_id = assignment.google_customer_id

    if campaign_id and customer_id:
        try:
            from app.services.google_ads_client_factory import create_google_ads_client
            mcc = db.query(GoogleMccAccount).first()
            if mcc:
                client, _ = create_google_ads_client(mcc)
                cid = customer_id.replace("-", "")
                campaign_service = client.get_service("CampaignService")
                resource_name = campaign_service.campaign_path(cid, campaign_id)

                campaign_op = client.get_type("CampaignOperation")
                campaign_op.remove = resource_name

                campaign_service.mutate_campaigns(
                    customer_id=cid,
                    operations=[campaign_op],
                )
                logger.info(f"[AdDelete] Google Ads 广告系列已删除: CID={cid}, campaign={campaign_id}")
        except Exception as e:
            logger.warning(f"[AdDelete] Google Ads 删除失败（将清除本地记录）: {e}")

    assignment.google_campaign_id = None
    assignment.google_customer_id = None
    assignment.daily_budget = None
    db.commit()

    return {"message": "广告已删除", "assignment_id": assignment_id}


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
