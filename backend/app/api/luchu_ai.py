"""
露出 AI 功能 API - Claude 分析和内容生成
支持异步任务架构，解决 Cloudflare 超时问题
"""
import json
import logging
import uuid
import asyncio
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.database import get_db, SessionLocal
from app.models.user import User
from app.models.luchu import LuchuPromptTemplate, LuchuCrawlCache, LuchuWebsite, LuchuAnalyzeTask
from app.schemas.luchu import (
    AnalyzeMerchantRequest, AnalyzeMerchantResponse,
    GenerateArticleRequest, GenerateArticleResponse
)
from app.middleware.auth import get_current_user, get_luchu_authorized_user
from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/luchu/ai", tags=["luchu-ai"])


# ============ 异步任务相关 Schema ============

class AnalyzeTaskResponse(BaseModel):
    """异步分析任务响应"""
    task_id: str
    status: str
    message: str


class TaskStatusResponse(BaseModel):
    """任务状态响应"""
    task_id: str
    status: str  # pending/processing/completed/failed
    progress: int  # 0-100
    stage: Optional[str] = None  # 当前阶段
    data: Optional[dict] = None  # 完成时的结果数据
    error: Optional[str] = None  # 错误信息


# ============ 异步后台任务处理函数 ============

async def _run_analyze_task(task_id: str, url: str, user_id: int):
    """
    后台执行分析任务
    独立于 HTTP 请求周期，不会超时
    """
    db = SessionLocal()
    try:
        # 更新任务状态为 processing
        task = db.query(LuchuAnalyzeTask).filter(LuchuAnalyzeTask.task_id == task_id).first()
        if not task:
            logger.error(f"[Luchu AI] 任务不存在: {task_id}")
            return
        
        task.status = "processing"
        task.started_at = datetime.utcnow()
        task.progress = 10
        task.stage = "正在连接商家网站..."
        db.commit()
        
        # 检查缓存
        import hashlib
        url_hash = hashlib.md5(url.encode()).hexdigest()
        cache = db.query(LuchuCrawlCache).filter(LuchuCrawlCache.url_hash == url_hash).first()
        
        if cache and cache.crawl_data:
            if cache.expires_at and cache.expires_at > datetime.utcnow():
                logger.info(f"[Luchu AI] 任务 {task_id} 使用缓存数据")
                task.status = "completed"
                task.progress = 100
                task.stage = "已完成（使用缓存）"
                task.result_data = cache.crawl_data
                task.completed_at = datetime.utcnow()
                db.commit()
                return
        
        # 更新进度
        task.progress = 20
        task.stage = "正在渲染页面..."
        db.commit()
        
        # 执行分析
        from app.services.claude_service import get_claude_service
        claude = get_claude_service(settings.CLAUDE_API_KEY)
        
        # 更新进度
        task.progress = 40
        task.stage = "正在提取图片..."
        db.commit()
        
        result = await claude.analyze_merchant_url(url)
        
        # 更新进度
        task.progress = 80
        task.stage = "正在保存结果..."
        db.commit()
        
        # 保存缓存
        if cache:
            cache.crawl_data = json.dumps(result)
            cache.images = json.dumps(result.get('images', []))
            cache.expires_at = datetime.utcnow() + timedelta(hours=24)
        else:
            cache = LuchuCrawlCache(
                url=url,
                url_hash=url_hash,
                crawl_data=json.dumps(result),
                images=json.dumps(result.get('images', [])),
                expires_at=datetime.utcnow() + timedelta(hours=24)
            )
            db.add(cache)
        
        # 更新任务状态为完成
        task.status = "completed"
        task.progress = 100
        task.stage = "分析完成"
        task.result_data = json.dumps(result)
        task.completed_at = datetime.utcnow()
        db.commit()
        
        logger.info(f"[Luchu AI] 任务 {task_id} 完成: {result.get('brand_name', 'Unknown')}")
        
    except Exception as e:
        logger.error(f"[Luchu AI] 任务 {task_id} 失败: {e}")
        try:
            task = db.query(LuchuAnalyzeTask).filter(LuchuAnalyzeTask.task_id == task_id).first()
            if task:
                task.status = "failed"
                task.error_message = str(e)
                task.completed_at = datetime.utcnow()
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


@router.post("/analyze", response_model=AnalyzeTaskResponse)
async def analyze_merchant_url(
    data: AnalyzeMerchantRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """
    分析商家URL（异步模式）
    
    返回 task_id，前端通过轮询 /task/{task_id}/status 获取进度和结果
    """
    logger.info(f"[Luchu AI] 用户 {current_user.username} 请求分析: {data.url}")
    
    # 检查 Claude API Key
    if not settings.CLAUDE_API_KEY:
        raise HTTPException(status_code=500, detail="Claude API Key 未配置")
    
    # 检查是否有缓存（如果有，可以直接返回，不需要异步）
    import hashlib
    url_hash = hashlib.md5(data.url.encode()).hexdigest()
    cache = db.query(LuchuCrawlCache).filter(LuchuCrawlCache.url_hash == url_hash).first()
    
    if cache and cache.crawl_data:
        if cache.expires_at and cache.expires_at > datetime.utcnow():
            logger.info(f"[Luchu AI] 使用缓存数据（快速返回）")
            # 有缓存时，创建一个已完成的任务
            task_id = uuid.uuid4().hex
            task = LuchuAnalyzeTask(
                task_id=task_id,
                user_id=current_user.id,
                url=data.url,
                status="completed",
                progress=100,
                stage="已完成（使用缓存）",
                result_data=cache.crawl_data,
                completed_at=datetime.utcnow()
            )
            db.add(task)
            db.commit()
            
            return AnalyzeTaskResponse(
                task_id=task_id,
                status="completed",
                message="分析完成（使用缓存）"
            )
    
    # 创建异步任务
    task_id = uuid.uuid4().hex
    task = LuchuAnalyzeTask(
        task_id=task_id,
        user_id=current_user.id,
        url=data.url,
        status="pending",
        progress=0,
        stage="任务已创建，等待处理..."
    )
    db.add(task)
    db.commit()
    
    # 启动后台任务
    asyncio.create_task(_run_analyze_task(task_id, data.url, current_user.id))
    
    logger.info(f"[Luchu AI] 创建异步任务: {task_id}")
    
    return AnalyzeTaskResponse(
        task_id=task_id,
        status="pending",
        message="分析任务已创建，请轮询获取进度"
    )


@router.get("/task/{task_id}/status", response_model=TaskStatusResponse)
async def get_task_status(
    task_id: str,
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """
    获取分析任务状态
    
    前端应每 2-3 秒轮询此接口，直到 status 为 completed 或 failed
    """
    task = db.query(LuchuAnalyzeTask).filter(
        LuchuAnalyzeTask.task_id == task_id,
        LuchuAnalyzeTask.user_id == current_user.id
    ).first()
    
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    
    response = TaskStatusResponse(
        task_id=task_id,
        status=task.status,
        progress=task.progress or 0,
        stage=task.stage
    )
    
    if task.status == "completed" and task.result_data:
        try:
            response.data = json.loads(task.result_data)
        except Exception:
            response.data = None
    
    if task.status == "failed":
        response.error = task.error_message
    
    return response


@router.post("/generate", response_model=GenerateArticleResponse)
async def generate_article_content(
    data: GenerateArticleRequest,
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """
    生成文章内容
    """
    logger.info(f"[Luchu AI] 用户 {current_user.username} 请求生成文章")
    
    # 检查 Claude API Key
    if not settings.CLAUDE_API_KEY:
        raise HTTPException(status_code=500, detail="Claude API Key 未配置")
    
    # 获取提示词模板
    if data.prompt_template_id:
        template = db.query(LuchuPromptTemplate).filter(
            LuchuPromptTemplate.id == data.prompt_template_id
        ).first()
        if not template:
            raise HTTPException(status_code=404, detail="提示词模板不存在")
        prompt_template = template.template_content
    else:
        # 使用默认模板
        template = db.query(LuchuPromptTemplate).filter(
            LuchuPromptTemplate.is_default == 1
        ).first()
        
        if template:
            prompt_template = template.template_content
        else:
            # 内置默认模板
            prompt_template = _get_default_prompt_template()
    
    # 获取网站信息
    website = db.query(LuchuWebsite).filter(LuchuWebsite.id == data.website_id).first()
    if not website:
        raise HTTPException(status_code=404, detail="网站不存在")
    
    try:
        from app.services.claude_service import get_claude_service
        
        claude = get_claude_service(settings.CLAUDE_API_KEY)
        result = await claude.generate_article(
            merchant_data=data.merchant_data,
            tracking_link=data.tracking_link,
            keyword_count=data.keyword_count,
            prompt_template=prompt_template,
            images=data.images,
            target_country=data.target_country,
            target_language=data.target_language,
            target_country_name=data.target_country_name or data.target_country
        )
        
        logger.info(f"[Luchu AI] 文章生成完成: {result.get('title', 'Untitled')}")
        
        return GenerateArticleResponse(
            title=result.get('title', ''),
            slug=result.get('slug', ''),
            category=result.get('category', ''),
            category_name=result.get('categoryName', result.get('category_name', '')),
            excerpt=result.get('excerpt', ''),
            content=result.get('content', ''),
            images=result.get('images', {}),
            products=result.get('products'),
            keyword_actual_count=result.get('keywordActualCount', result.get('keyword_actual_count'))
        )
        
    except Exception as e:
        logger.error(f"[Luchu AI] 生成失败: {e}")
        raise HTTPException(status_code=500, detail=f"生成失败: {str(e)}")


@router.post("/regenerate")
async def regenerate_section(
    article_id: int,
    section: str,
    instructions: str,
    current_user: User = Depends(get_luchu_authorized_user),
    db: Session = Depends(get_db)
):
    """
    重新生成文章的某个部分
    """
    from app.models.luchu import LuchuArticle
    
    article = db.query(LuchuArticle).filter(LuchuArticle.id == article_id).first()
    if not article:
        raise HTTPException(status_code=404, detail="文章不存在")
    
    # 权限检查
    if current_user.role not in ['manager', 'leader'] and article.author_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权修改此文章")
    
    if section not in ['title', 'excerpt', 'content']:
        raise HTTPException(status_code=400, detail="无效的部分")
    
    try:
        from app.services.claude_service import get_claude_service
        
        claude = get_claude_service(settings.CLAUDE_API_KEY)
        
        current_content = getattr(article, section, '')
        merchant_data = {
            'brand_name': article.brand_name,
            'tracking_link': article.tracking_link
        }
        
        new_content = await claude.regenerate_section(
            current_content=current_content,
            section=section,
            instructions=instructions,
            merchant_data=merchant_data
        )
        
        return {"section": section, "content": new_content}
        
    except Exception as e:
        logger.error(f"[Luchu AI] 重新生成失败: {e}")
        raise HTTPException(status_code=500, detail=f"重新生成失败: {str(e)}")


def _get_default_prompt_template() -> str:
    """获取内置默认提示词模板"""
    return '''你是一位专业的博客内容撰写者。请根据以下商家信息撰写一篇高质量的推广博客文章。

## 商家信息
[商家信息]

## 要求
1. 文章标题要吸引人，包含品牌名称
2. 品牌关键词"[品牌名称]"在正文中出现 [关键词次数] 次
3. 正文使用 HTML 格式，包含 <p>, <h2>, <h3>, <ul>, <li> 等标签
4. 在适当位置插入图片标记 [IMAGE_1], [IMAGE_2] 等
5. 包含行动号召，引导点击追踪链接: [追踪链接]
6. 文章长度 800-1200 字
7. 语言风格：专业、友好、有说服力

## 输出格式 (JSON)
{
  "title": "文章标题",
  "slug": "url-friendly-slug",
  "category": "分类代码",
  "categoryName": "分类名称",
  "excerpt": "文章摘要 (150字内)",
  "content": "<p>HTML正文...</p>",
  "keywordActualCount": 实际关键词次数
}'''

