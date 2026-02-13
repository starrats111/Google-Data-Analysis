"""
露出 AI 功能 API - Claude 分析和内容生成
"""
import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.luchu import LuchuPromptTemplate, LuchuCrawlCache, LuchuWebsite
from app.schemas.luchu import (
    AnalyzeMerchantRequest, AnalyzeMerchantResponse,
    GenerateArticleRequest, GenerateArticleResponse
)
from app.middleware.auth import get_current_user
from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/luchu/ai", tags=["luchu-ai"])


@router.post("/analyze", response_model=AnalyzeMerchantResponse)
async def analyze_merchant_url(
    data: AnalyzeMerchantRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    分析商家URL，提取品牌信息和图片
    使用 Claude Tool Use 模式自动爬取网页
    """
    logger.info(f"[Luchu AI] 用户 {current_user.username} 请求分析: {data.url}")
    
    # 检查 Claude API Key
    if not settings.CLAUDE_API_KEY:
        raise HTTPException(status_code=500, detail="Claude API Key 未配置")
    
    # 检查缓存
    import hashlib
    url_hash = hashlib.md5(data.url.encode()).hexdigest()
    cache = db.query(LuchuCrawlCache).filter(LuchuCrawlCache.url_hash == url_hash).first()
    
    if cache and cache.crawl_data:
        from datetime import datetime
        if cache.expires_at and cache.expires_at > datetime.utcnow():
            logger.info(f"[Luchu AI] 使用缓存数据")
            try:
                cached_data = json.loads(cache.crawl_data)
                return AnalyzeMerchantResponse(**cached_data)
            except Exception:
                pass  # 缓存无效，继续分析
    
    try:
        from app.services.claude_service import get_claude_service
        
        claude = get_claude_service(settings.CLAUDE_API_KEY)
        result = await claude.analyze_merchant_url(data.url)
        
        # 保存缓存
        from datetime import datetime, timedelta
        if cache:
            cache.crawl_data = json.dumps(result)
            cache.images = json.dumps(result.get('images', []))
            cache.expires_at = datetime.utcnow() + timedelta(hours=24)
        else:
            cache = LuchuCrawlCache(
                url=data.url,
                url_hash=url_hash,
                crawl_data=json.dumps(result),
                images=json.dumps(result.get('images', [])),
                expires_at=datetime.utcnow() + timedelta(hours=24)
            )
            db.add(cache)
        
        db.commit()
        
        logger.info(f"[Luchu AI] 分析完成: {result.get('brand_name', 'Unknown')}")
        
        return AnalyzeMerchantResponse(
            brand_name=result.get('brand_name', ''),
            brand_description=result.get('brand_description'),
            product_type=result.get('product_type'),
            promotions=result.get('promotions'),
            products=result.get('products'),
            images=result.get('images', []),
            category_suggestion=result.get('category_suggestion')
        )
        
    except Exception as e:
        logger.error(f"[Luchu AI] 分析失败: {e}")
        raise HTTPException(status_code=500, detail=f"分析失败: {str(e)}")


@router.post("/generate", response_model=GenerateArticleResponse)
async def generate_article_content(
    data: GenerateArticleRequest,
    current_user: User = Depends(get_current_user),
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
    current_user: User = Depends(get_current_user),
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

