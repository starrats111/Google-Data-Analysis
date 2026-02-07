"""
Gemini AI API 端点
"""
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.orm import Session
from typing import Optional, List
from pydantic import BaseModel
from datetime import date, datetime
import logging

from app.database import get_db
from app.models.user import User
from app.models.ai_report import AIReport, UserPrompt
from app.api.auth import get_current_user
from app.services.gemini_service import GeminiService
from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/gemini", tags=["Gemini AI"])


def get_gemini_service(model_type: str = "default") -> GeminiService:
    """获取 Gemini 服务实例
    
    Args:
        model_type: 模型类型
            - "default": 默认模型（gemini-2.5-flash-lite，最便宜）
            - "advanced": 高级模型（gemini-3-flash-preview，最新）
            - "thinking": 思考模型（gemini-3-flash-preview-thinking，深度分析）
    """
    api_key = getattr(settings, 'gemini_api_key', None)
    if not api_key:
        raise HTTPException(status_code=500, detail="Gemini API 密钥未配置")
    
    base_url = getattr(settings, 'gemini_base_url', None) or "https://api.gemai.cc/v1beta"
    
    # 根据类型选择模型
    if model_type == "advanced":
        model = getattr(settings, 'gemini_model_advanced', "gemini-3-flash-preview")
    elif model_type == "thinking":
        model = getattr(settings, 'gemini_model_thinking', "gemini-3-flash-preview-thinking")
    else:
        model = getattr(settings, 'gemini_model', "gemini-2.5-flash-lite")
    
    return GeminiService(api_key, base_url, model)


# 模型列表，用于自动降级
MODEL_FALLBACK_ORDER = [
    "gemini-2.5-flash-lite",        # 最便宜，优先
    "gemini-3-flash-preview",        # 备用1
    "gemini-3-flash-preview-thinking" # 备用2
]


class CampaignAnalysisRequest(BaseModel):
    """广告分析请求"""
    campaign_name: str
    cost: float
    clicks: int
    impressions: int
    cpc: float
    budget: float
    is_budget_lost: Optional[float] = 0
    is_rank_lost: Optional[float] = 0
    orders: Optional[int] = 0
    commission: Optional[float] = 0
    roi: Optional[float] = None
    # 可选：指定使用的模型 (default/advanced/thinking)
    model_type: Optional[str] = "default"


class KeywordsRecommendRequest(BaseModel):
    """关键词推荐请求"""
    keywords: List[str]
    product_url: Optional[str] = None
    target_country: str = "US"


class MarketingCalendarRequest(BaseModel):
    """营销日历请求"""
    country: str = "US"
    month: Optional[int] = None
    year: Optional[int] = None


class L7DCampaignData(BaseModel):
    """L7D 广告系列数据"""
    campaign_name: str
    cost: float = 0
    clicks: int = 0
    impressions: int = 0
    cpc: float = 0
    budget: float = 0
    conservative_epc: float = 0  # 保守EPC（已含0.72系数）
    is_budget_lost: float = 0    # Budget丢失比例（0-1）
    is_rank_lost: float = 0      # Rank丢失比例（0-1）
    orders: int = 0
    order_days: int = 0          # 出单天数
    commission: float = 0


class L7DAnalysisRequest(BaseModel):
    """L7D 分析请求"""
    campaigns: List[L7DCampaignData]
    model_type: Optional[str] = "thinking"  # L7D分析默认用thinking模型


class GenerateReportRequest(BaseModel):
    """生成报告请求"""
    campaigns: List[L7DCampaignData]
    analysis_result_id: Optional[int] = None
    model_type: Optional[str] = "thinking"


class UserPromptRequest(BaseModel):
    """用户自定义提示词"""
    prompt: str


@router.post("/analyze-campaign")
async def analyze_campaign(
    request: CampaignAnalysisRequest,
    current_user: User = Depends(get_current_user)
):
    """
    A. 分析广告数据，生成优化建议
    
    model_type 参数：
    - default: gemini-2.5-flash-lite（最便宜，日常用）
    - advanced: gemini-3-flash-preview（最新模型）
    - thinking: gemini-3-flash-preview-thinking（深度分析）
    """
    try:
        model_type = request.model_type or "default"
        service = get_gemini_service(model_type)
        
        # 计算ROI（如果没有提供）
        campaign_data = request.dict()
        campaign_data.pop("model_type", None)  # 移除model_type字段
        if campaign_data.get("roi") is None and campaign_data.get("cost", 0) > 0:
            commission = campaign_data.get("commission", 0)
            cost = campaign_data.get("cost", 0)
            campaign_data["roi"] = ((commission * 0.72 - cost) / cost * 100) if cost > 0 else 0
        
        result = service.analyze_campaign_data(campaign_data)
        
        # 如果失败，自动尝试备用模型
        if not result.get("success") and model_type == "default":
            for fallback_type in ["advanced", "thinking"]:
                try:
                    service = get_gemini_service(fallback_type)
                    result = service.analyze_campaign_data(campaign_data)
                    if result.get("success"):
                        result["used_model"] = fallback_type
                        break
                except:
                    continue
        
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/generate-instructions")
async def generate_instructions(
    request: CampaignAnalysisRequest,
    current_user: User = Depends(get_current_user)
):
    """
    B. 智能生成操作指令
    """
    try:
        service = get_gemini_service()
        campaign_data = request.dict()
        result = service.generate_operation_instruction(campaign_data)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/recommend-keywords")
async def recommend_keywords(
    request: KeywordsRecommendRequest,
    current_user: User = Depends(get_current_user)
):
    """
    C. 根据关键词生成推荐预算、CPC和广告词
    """
    try:
        service = get_gemini_service()
        result = service.analyze_keywords_and_recommend(
            keywords=request.keywords,
            product_url=request.product_url,
            target_country=request.target_country
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/marketing-calendar")
async def get_marketing_calendar(
    request: MarketingCalendarRequest,
    current_user: User = Depends(get_current_user)
):
    """
    D. 获取热门节日和推荐商家
    """
    try:
        service = get_gemini_service()
        result = service.get_marketing_calendar(
            country=request.country,
            month=request.month,
            year=request.year
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/marketing-calendar/{country}")
async def get_marketing_calendar_by_country(
    country: str,
    month: Optional[int] = None,
    year: Optional[int] = None,
    current_user: User = Depends(get_current_user)
):
    """
    D. 按国家获取热门节日（GET方式）
    
    支持的国家：US, UK, DE, FR, ES, IT, AU, CA, JP, KR
    """
    try:
        service = get_gemini_service()
        result = service.get_marketing_calendar(
            country=country.upper(),
            month=month,
            year=year
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/analyze-image")
async def analyze_image(
    file: UploadFile = File(...),
    prompt: Optional[str] = Form(None),
    current_user: User = Depends(get_current_user)
):
    """
    分析图片（如关键词截图）生成推荐配置
    """
    try:
        # 读取图片数据
        image_data = await file.read()
        
        service = get_gemini_service()
        result = service.analyze_image(image_data, prompt)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/batch-analyze")
async def batch_analyze_campaigns(
    campaigns: List[CampaignAnalysisRequest],
    current_user: User = Depends(get_current_user)
):
    """
    批量分析多个广告系列
    """
    try:
        service = get_gemini_service()
        
        # 准备数据
        campaigns_data = [c.dict() for c in campaigns]
        
        # 构建汇总数据
        summary = {
            "total_campaigns": len(campaigns_data),
            "total_cost": sum(c.get("cost", 0) for c in campaigns_data),
            "total_clicks": sum(c.get("clicks", 0) for c in campaigns_data),
            "total_impressions": sum(c.get("impressions", 0) for c in campaigns_data),
            "total_orders": sum(c.get("orders", 0) for c in campaigns_data),
            "total_commission": sum(c.get("commission", 0) for c in campaigns_data),
            "campaigns": campaigns_data
        }
        
        result = service.analyze_campaign_data(summary)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/analyze-l7d")
async def analyze_l7d_campaigns(
    request: L7DAnalysisRequest,
    current_user: User = Depends(get_current_user)
):
    """
    L7D 广告系列审计分析
    
    基于品牌词套利审计提示词 v5 版本，对广告系列进行：
    - 全量审计与 S/B/D 分级
    - 输出可执行的操作方案
    - 效果预测与可行性判定
    
    model_type 参数（默认 thinking）：
    - default: gemini-2.5-flash-lite（最便宜）
    - advanced: gemini-3-flash-preview（最新模型）
    - thinking: gemini-3-flash-preview-thinking（深度分析，推荐）
    """
    try:
        model_type = request.model_type or "thinking"
        service = get_gemini_service(model_type)
        
        # 准备数据
        campaigns_data = [c.dict() for c in request.campaigns]
        
        result = service.analyze_l7d_campaigns(campaigns_data)
        
        # 如果失败，自动尝试备用模型
        if not result.get("success"):
            for fallback_type in ["advanced", "default"]:
                if fallback_type != model_type:
                    try:
                        service = get_gemini_service(fallback_type)
                        result = service.analyze_l7d_campaigns(campaigns_data)
                        if result.get("success"):
                            result["used_model"] = fallback_type
                            break
                    except:
                        continue
        
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/generate-report")
async def generate_report(
    request: GenerateReportRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    生成 AI 分析报告并保存
    
    返回包含可执行操作指令的报告，格式如：
    - CPC 0.10→0.08
    - 预算 $10.00→$15.00(+50%)
    """
    try:
        model_type = request.model_type or "thinking"
        service = get_gemini_service(model_type)
        
        campaigns_data = [c.dict() for c in request.campaigns]
        
        # 获取用户自定义提示词
        user_prompt = db.query(UserPrompt).filter(UserPrompt.user_id == current_user.id).first()
        custom_prompt = user_prompt.prompt if user_prompt else None
        
        # 生成报告
        result = service.generate_operation_report(campaigns_data, custom_prompt)
        
        if result.get("success"):
            # 保存报告到数据库
            report = AIReport(
                user_id=current_user.id,
                analysis_result_id=request.analysis_result_id,
                content=result.get("analysis", ""),
                campaign_count=len(campaigns_data)
            )
            db.add(report)
            db.commit()
            db.refresh(report)
            
            result["report_id"] = report.id
        
        return result
    except Exception as e:
        logger.error(f"生成报告失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/reports")
async def get_reports(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取当前用户的所有报告"""
    try:
        reports = db.query(AIReport).filter(
            AIReport.user_id == current_user.id
        ).order_by(AIReport.created_at.desc()).all()
        
        return [
            {
                "id": r.id,
                "content": r.content,
                "campaign_count": r.campaign_count,
                "created_at": r.created_at.isoformat() if r.created_at else None
            }
            for r in reports
        ]
    except Exception as e:
        logger.error(f"获取报告列表失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/reports/{report_id}")
async def delete_report(
    report_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """删除报告"""
    try:
        report = db.query(AIReport).filter(
            AIReport.id == report_id,
            AIReport.user_id == current_user.id
        ).first()
        
        if not report:
            raise HTTPException(status_code=404, detail="报告不存在")
        
        db.delete(report)
        db.commit()
        
        return {"success": True, "message": "删除成功"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"删除报告失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/user-prompt")
async def get_user_prompt(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取用户自定义提示词"""
    try:
        user_prompt = db.query(UserPrompt).filter(
            UserPrompt.user_id == current_user.id
        ).first()
        
        return {"prompt": user_prompt.prompt if user_prompt else ""}
    except Exception as e:
        logger.error(f"获取提示词失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/user-prompt")
async def save_user_prompt(
    request: UserPromptRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """保存用户自定义提示词"""
    try:
        user_prompt = db.query(UserPrompt).filter(
            UserPrompt.user_id == current_user.id
        ).first()
        
        if user_prompt:
            user_prompt.prompt = request.prompt
        else:
            user_prompt = UserPrompt(
                user_id=current_user.id,
                prompt=request.prompt
            )
            db.add(user_prompt)
        
        db.commit()
        
        return {"success": True, "message": "保存成功"}
    except Exception as e:
        logger.error(f"保存提示词失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))

