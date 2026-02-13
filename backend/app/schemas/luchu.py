"""
露出功能 Pydantic 模型
"""
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from datetime import datetime, date


# ============ 网站相关 ============

class LuchuWebsiteBase(BaseModel):
    name: str
    domain: str
    github_repo: str
    data_path: str = "js/articles"
    has_products: bool = True
    site_url: Optional[str] = None
    is_active: bool = True


class LuchuWebsiteCreate(LuchuWebsiteBase):
    owner_id: Optional[int] = None


class LuchuWebsiteResponse(LuchuWebsiteBase):
    id: int
    owner_id: Optional[int] = None
    created_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True


# ============ 文章相关 ============

class LuchuArticleBase(BaseModel):
    title: str
    slug: Optional[str] = None
    category: Optional[str] = None
    category_name: Optional[str] = None
    excerpt: Optional[str] = None
    content: Optional[str] = None
    merchant_url: Optional[str] = None
    tracking_link: Optional[str] = None
    brand_name: Optional[str] = None
    brand_keyword: Optional[str] = None
    keyword_count: int = 10
    publish_date: Optional[date] = None
    # 目标国家/语言
    target_country: Optional[str] = "US"
    target_language: Optional[str] = "en-US"


class LuchuArticleCreate(LuchuArticleBase):
    website_id: int
    images: Optional[Dict[str, Any]] = None
    products: Optional[List[Dict[str, Any]]] = None


class LuchuArticleUpdate(BaseModel):
    title: Optional[str] = None
    slug: Optional[str] = None
    category: Optional[str] = None
    category_name: Optional[str] = None
    excerpt: Optional[str] = None
    content: Optional[str] = None
    images: Optional[Dict[str, Any]] = None
    products: Optional[List[Dict[str, Any]]] = None
    tracking_link: Optional[str] = None
    keyword_count: Optional[int] = None
    publish_date: Optional[date] = None
    status: Optional[str] = None


class LuchuArticleResponse(LuchuArticleBase):
    id: int
    website_id: int
    author_id: int
    status: str
    images: Optional[Dict[str, Any]] = None
    products: Optional[List[Dict[str, Any]]] = None
    version: int
    target_country: Optional[str] = "US"
    target_language: Optional[str] = "en-US"
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    published_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True


class LuchuArticleListResponse(BaseModel):
    id: int
    title: str
    status: str
    website_id: int
    website_name: Optional[str] = None
    author_id: int
    author_name: Optional[str] = None
    publish_date: Optional[date] = None
    created_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True


# ============ AI 相关 ============

class AnalyzeMerchantRequest(BaseModel):
    url: str = Field(..., description="商家网站URL")


class AnalyzeMerchantResponse(BaseModel):
    brand_name: str
    brand_description: Optional[str] = None
    product_type: Optional[str] = None
    promotions: Optional[List[str]] = None
    products: Optional[List[Dict[str, Any]]] = None
    images: List[Dict[str, Any]]
    category_suggestion: Optional[str] = None


class GenerateArticleRequest(BaseModel):
    merchant_data: Dict[str, Any]
    tracking_link: str
    website_id: int
    keyword_count: int = 10
    publish_date: Optional[date] = None
    prompt_template_id: Optional[int] = None
    images: Optional[List[Dict[str, Any]]] = None
    # 目标国家/语言（本地化）
    target_country: str = "US"
    target_language: str = "en-US"
    target_country_name: Optional[str] = "美国"


class GenerateArticleResponse(BaseModel):
    title: str
    slug: str
    category: str
    category_name: str
    excerpt: str
    content: str
    images: Dict[str, Any]
    products: Optional[List[Dict[str, Any]]] = None
    keyword_actual_count: Optional[int] = None


# ============ 审核相关 ============

class ReviewRequest(BaseModel):
    comment: Optional[str] = None


class ReviewResponse(BaseModel):
    id: int
    article_id: int
    reviewer_id: int
    status: str
    comment: Optional[str] = None
    created_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True


# ============ 发布相关 ============

class PublishRequest(BaseModel):
    commit_message: Optional[str] = None


class PublishResponse(BaseModel):
    success: bool
    commit_sha: Optional[str] = None
    file_path: Optional[str] = None
    article_url: Optional[str] = None
    error: Optional[str] = None


# ============ 通知相关 ============

class NotificationResponse(BaseModel):
    id: int
    type: str
    title: str
    content: Optional[str] = None
    related_type: Optional[str] = None
    related_id: Optional[int] = None
    is_read: bool
    created_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True


# ============ 提示词模板 ============

class PromptTemplateBase(BaseModel):
    name: str
    description: Optional[str] = None
    category: Optional[str] = None
    has_products: bool = True
    template_content: str
    is_default: bool = False


class PromptTemplateCreate(PromptTemplateBase):
    website_id: Optional[int] = None


class PromptTemplateResponse(PromptTemplateBase):
    id: int
    website_id: Optional[int] = None
    created_by: Optional[int] = None
    created_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True


# ============ 版本历史 ============

class ArticleVersionResponse(BaseModel):
    id: int
    article_id: int
    version_number: int
    title: Optional[str] = None
    change_type: Optional[str] = None
    change_reason: Optional[str] = None
    changed_by: Optional[int] = None
    changer_name: Optional[str] = None
    created_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True


# ============ 统计相关 ============

class LuchuDashboardStats(BaseModel):
    my_articles: int
    pending_review: int
    ready_to_publish: int
    total_published: int
    unread_notifications: int
    image_alerts: int


class LuchuPublishTrend(BaseModel):
    date: str
    count: int

