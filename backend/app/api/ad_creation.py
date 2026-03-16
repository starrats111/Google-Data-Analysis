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
    holiday_name: Optional[str] = None


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
    sitelinks: Optional[List[dict]] = None
    callouts: Optional[List[str]] = None
    image_urls: Optional[List[str]] = None
    logo_url: Optional[str] = None
    compliance: Optional[dict] = None  # 限制品合规设置


class ModifyAdCopyRequest(BaseModel):
    headlines: List[str] = Field(default_factory=list)
    descriptions: List[str] = Field(default_factory=list)
    instruction: str = ""
    merchant_name: str = ""
    target_country: str = "US"


class MerchantAssetsRequest(BaseModel):
    url: str


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


@router.post("/refresh-cid-list")
async def refresh_cid_list(
    data: FindCidRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """手动刷新 MCC 的 CID 列表（调用一次 Google Ads API）"""
    import json as _json
    mcc = db.query(GoogleMccAccount).filter(GoogleMccAccount.id == data.mcc_id).first()
    if not mcc:
        raise HTTPException(status_code=404, detail="MCC 不存在")

    try:
        from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
        sync_svc = GoogleAdsServiceAccountSync(db)
        client, mcc_customer_id = sync_svc._create_client(mcc)
        customers = sync_svc.get_accessible_customers(client, mcc_customer_id)
        cid_list = sorted([c["id"] for c in customers])
        mcc.child_customer_ids = _json.dumps(cid_list)
        mcc.total_customers = len(cid_list)
        db.add(mcc)
        db.commit()
        return {"success": True, "count": len(cid_list), "cids": cid_list}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"刷新失败: {str(e)[:200]}")


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
    is_holiday = bool(data.holiday_name)

    if not is_holiday and data.mcc_id:
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

        if is_holiday:
            yield sse({"phase": "analyzing", "text": f"🎉 节日营销模式 — {data.holiday_name}\n"})
            yield sse({"phase": "history", "text": f"✓ 文案将贴合{data.holiday_name}节日氛围\n"})
        else:
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
                holiday_name=data.holiday_name,
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


@router.post("/modify-ad-copy")
async def modify_ad_copy(
    data: ModifyAdCopyRequest,
    current_user: User = Depends(get_current_user),
):
    """AI 根据用户指令修改广告文案"""
    from app.services.ad_copy_generator import ad_copy_generator, COUNTRY_LANGUAGE_MAP

    country_info = COUNTRY_LANGUAGE_MAP.get(data.target_country, COUNTRY_LANGUAGE_MAP["US"])
    language = country_info["language"]

    current_headlines = "\n".join(f"{i+1}. {h}" for i, h in enumerate(data.headlines))
    current_descs = "\n".join(f"{i+1}. {d}" for i, d in enumerate(data.descriptions))

    prompt = f"""你是 Google Ads RSA 文案专家。

商家: {data.merchant_name}
广告语言: {language}

当前标题（共{len(data.headlines)}条）:
{current_headlines}

当前描述（共{len(data.descriptions)}条）:
{current_descs}

用户要求: {data.instruction}

请根据用户要求修改文案。规则:
- 标题每条 ≤ 30 字符，描述每条 ≤ 90 字符
- 如果用户只要求修改部分，保留其他不变
- 遵守 Google Ads 政策（禁止夸大/误导/全大写）
- 文案用 {language}，翻译用中文

返回 JSON:
```json
{{"headlines": ["修改后的标题列表"], "headline_translations": ["每条标题的完整中文翻译句子，不能只写品牌名"], "descriptions": ["修改后的描述列表"], "description_translations": ["每条描述的完整中文翻译句子，不能只写品牌名"], "reply": "简短说明你做了什么修改"}}
```"""

    messages = [{"role": "user", "content": prompt}]
    try:
        raw = ad_copy_generator.gen_service._call_with_fallback(messages, max_tokens=2000, fast=True)
        result = ad_copy_generator._parse_json(raw)

        headlines = [h[:30] for h in result.get("headlines", data.headlines)]
        descriptions = [d[:90] for d in result.get("descriptions", data.descriptions)]
        headline_translations = result.get("headline_translations", [])
        description_translations = result.get("description_translations", [])

        while len(headline_translations) < len(headlines):
            headline_translations.append("")
        while len(description_translations) < len(descriptions):
            description_translations.append("")

        return {
            "headlines": headlines,
            "descriptions": descriptions,
            "headline_translations": headline_translations,
            "description_translations": description_translations,
            "reply": result.get("reply", "已按要求修改文案"),
        }
    except Exception as e:
        logger.error(f"[ModifyAdCopy] 修改失败: {e}")
        raise HTTPException(status_code=500, detail=f"AI 修改失败: {str(e)}")


@router.post("/merchant-assets")
async def get_merchant_assets(
    data: MerchantAssetsRequest,
    current_user: User = Depends(get_current_user),
):
    """快速获取商家网站的图片和 Logo（用于广告素材）"""
    from app.services.merchant_crawler import crawl_merchant
    try:
        crawl_data = crawl_merchant(data.url)
        images = []
        for page in crawl_data.get("pages", []):
            for img in page.get("images", []):
                if img and img not in images and not any(x in img.lower() for x in ['icon', 'svg', 'favicon', '1x1', 'pixel']):
                    images.append(img)
                if len(images) >= 10:
                    break
            if len(images) >= 10:
                break
        logo = crawl_data.get("logo", "") or crawl_data.get("favicon", "")
        return {"images": images, "logo": logo}
    except Exception as e:
        logger.warning("[MerchantAssets] 获取失败: %s", e)
        return {"images": [], "logo": ""}


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

    # 检查该 CID 是否已有启用的广告系列（只看最新一天的数据）
    cid_clean = data.customer_id.replace("-", "") if data.customer_id else data.customer_id
    from sqlalchemy import func as sa_func
    latest_date = db.query(sa_func.max(GoogleAdsApiData.date)).filter(
        GoogleAdsApiData.mcc_id == data.mcc_id,
    ).scalar()
    if latest_date:
        existing_enabled = db.query(GoogleAdsApiData).filter(
            GoogleAdsApiData.customer_id.in_([data.customer_id, cid_clean]),
            GoogleAdsApiData.status == '已启用',
            GoogleAdsApiData.mcc_id == data.mcc_id,
            GoogleAdsApiData.date == latest_date,
        ).first()
        if existing_enabled:
            raise HTTPException(
                status_code=400,
                detail=f"CID {data.customer_id} 已有启用的广告系列「{existing_enabled.campaign_name}」，请选择其他空闲 CID",
            )

    from app.services.google_ads_creator import GoogleAdsCreator
    creator = GoogleAdsCreator(db)
    try:
        merchant = assignment.merchant
        # 如果有合规设置且需要添加负责任声明，自动追加到 descriptions
        descriptions_final = list(data.descriptions)
        if data.compliance and data.compliance.get("add_responsible_msg"):
            msg = data.compliance.get("responsible_msg", "")
            if msg and msg not in descriptions_final:
                descriptions_final.append(msg)

        result = creator.create_full_campaign(
            mcc_id=data.mcc_id,
            customer_id=data.customer_id,
            merchant_name=data.merchant_name,
            keywords=data.keywords,
            headlines=data.headlines,
            descriptions=descriptions_final,
            daily_budget=data.daily_budget,
            target_country=data.target_country,
            mode=data.mode,
            final_url=data.merchant_url,
            platform=merchant.platform if merchant else "",
            merchant_mid=merchant.merchant_id if merchant else "",
            assignment_id=data.assignment_id,
            user_id=current_user.id,
            sitelinks=data.sitelinks,
            callouts=data.callouts,
            image_urls=data.image_urls,
            logo_url=data.logo_url,
            compliance=data.compliance,
        )

        # 更新 assignment 记录
        new_campaign_id = result.get("campaign_id")
        assignment.google_campaign_id = new_campaign_id
        assignment.google_customer_id = data.customer_id
        assignment.daily_budget = data.daily_budget
        assignment.target_country = data.target_country
        assignment.mode = data.mode

        # 立即写入 GoogleAdsApiData，让数据中心可以立刻看到
        if new_campaign_id and not result.get("is_existing"):
            from datetime import date as date_type
            cid_clean = data.customer_id.replace("-", "") if data.customer_id else data.customer_id
            existing_record = db.query(GoogleAdsApiData).filter(
                GoogleAdsApiData.campaign_id == str(new_campaign_id),
                GoogleAdsApiData.date == date_type.today(),
            ).first()
            if not existing_record:
                new_record = GoogleAdsApiData(
                    mcc_id=data.mcc_id,
                    user_id=current_user.id,
                    customer_id=cid_clean,
                    campaign_id=str(new_campaign_id),
                    campaign_name=result.get("campaign_name", ""),
                    date=date_type.today(),
                    status="已启用",
                    budget=float(data.daily_budget) if data.daily_budget else 0,
                    cost=0,
                    impressions=0,
                    clicks=0,
                    cpc=0,
                    is_budget_lost=0,
                    is_rank_lost=0,
                )
                db.add(new_record)
                logger.info("[AdCreation] 已写入 GoogleAdsApiData: campaign=%s, cid=%s",
                            result.get("campaign_name"), cid_clean)

        db.commit()

        # 查找该商家的 campaign link
        campaign_link = ""
        if merchant and merchant.merchant_id:
            cache = db.query(CampaignLinkCache).filter(
                CampaignLinkCache.user_id == current_user.id,
                CampaignLinkCache.platform_code == merchant.platform,
                CampaignLinkCache.merchant_id == merchant.merchant_id,
            ).first()
            if cache:
                campaign_link = cache.campaign_link or cache.short_link or cache.smart_link or ""

        result["campaign_link"] = campaign_link
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/test-dashboard")
async def get_test_dashboard(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """测试商家看板 — 只展示广告侧数据（M-50 闭环）"""
    from sqlalchemy import func

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

        # 如果尚未关联广告系列，尝试通过 merchant_id 自动匹配
        if not a.google_campaign_id and merchant and merchant.merchant_id:
            mid = merchant.merchant_id
            matched = db.query(GoogleAdsApiData).filter(
                GoogleAdsApiData.user_id == current_user.id,
                GoogleAdsApiData.campaign_name.like(f"%-{mid}"),
            ).order_by(GoogleAdsApiData.date.desc()).first()

            if matched:
                a.google_campaign_id = matched.campaign_id
                a.google_customer_id = matched.customer_id
                budget_row = db.query(GoogleAdsApiData).filter(
                    GoogleAdsApiData.campaign_id == matched.campaign_id,
                    GoogleAdsApiData.customer_id == matched.customer_id,
                    GoogleAdsApiData.budget > 0,
                ).order_by(GoogleAdsApiData.date.desc()).first()
                if budget_row and budget_row.budget:
                    a.daily_budget = budget_row.budget
                try:
                    db.commit()
                    logger.info(
                        "Auto-linked test assignment %d to campaign %s (cid=%s)",
                        a.id, matched.campaign_id, matched.customer_id,
                    )
                except Exception:
                    db.rollback()

        if a.google_customer_id and a.google_campaign_id:
            cid_clean = a.google_customer_id.replace("-", "")
            ad_data = db.query(GoogleAdsApiData).filter(
                GoogleAdsApiData.user_id == current_user.id,
                GoogleAdsApiData.customer_id.in_([a.google_customer_id, cid_clean]),
                GoogleAdsApiData.campaign_id == a.google_campaign_id,
            ).order_by(GoogleAdsApiData.date.desc()).first()

            if not ad_data:
                ad_data = db.query(GoogleAdsApiData).filter(
                    GoogleAdsApiData.customer_id.in_([a.google_customer_id, cid_clean]),
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
            "commission_rate": merchant.commission_rate if merchant else "",
            "ad_data": {
                "cost": float(ad_data.cost or 0) if ad_data else 0,
                "clicks": int(ad_data.clicks or 0) if ad_data else 0,
                "impressions": int(ad_data.impressions or 0) if ad_data else 0,
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

    db.delete(assignment)
    db.commit()

    return {"message": "广告已删除", "assignment_id": assignment_id}


@router.post("/promote/{assignment_id}")
async def promote_to_production(
    assignment_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """将测试商家转为正式投放模式"""
    assignment = db.query(MerchantAssignment).filter(
        MerchantAssignment.id == assignment_id,
        MerchantAssignment.user_id == current_user.id,
    ).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="分配记录不存在或不属于你")
    if assignment.mode != "test":
        raise HTTPException(status_code=400, detail="该商家已是正式模式")

    assignment.mode = "normal"
    db.commit()
    logger.info(f"[AdPromotion] 测试转正式: assignment={assignment_id}, user={current_user.username}")
    return {"message": "已转为正式投放", "assignment_id": assignment_id}


@router.post("/remove/{assignment_id}")
async def remove_from_test(
    assignment_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """从测试看板移除（删除分配记录，不删广告）"""
    assignment = db.query(MerchantAssignment).filter(
        MerchantAssignment.id == assignment_id,
        MerchantAssignment.user_id == current_user.id,
    ).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="分配记录不存在或不属于你")

    db.delete(assignment)
    db.commit()
    logger.info(f"[AdRemove] 移除测试: assignment={assignment_id}, user={current_user.username}")
    return {"message": "已从测试看板移除", "assignment_id": assignment_id}


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
