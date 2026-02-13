"""
露出功能数据模型
"""
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey, Date
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class LuchuWebsite(Base):
    """露出网站配置"""
    __tablename__ = "luchu_websites"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    domain = Column(String(100), nullable=False)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    github_repo = Column(String(200), nullable=False)
    data_path = Column(String(100), default="js/articles")
    has_products = Column(Integer, default=1)
    site_url = Column(String(200))
    is_active = Column(Integer, default=1)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # 关系
    owner = relationship("User", foreign_keys=[owner_id])
    articles = relationship("LuchuArticle", back_populates="website")


class LuchuArticle(Base):
    """露出文章"""
    __tablename__ = "luchu_articles"
    
    id = Column(Integer, primary_key=True, index=True)
    website_id = Column(Integer, ForeignKey("luchu_websites.id"), nullable=True)
    author_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    
    title = Column(String(500), nullable=False)
    slug = Column(String(200))
    category = Column(String(50))
    category_name = Column(String(100))
    excerpt = Column(Text)
    content = Column(Text)
    
    images = Column(Text)  # JSON: {"hero":{...}, "content":[...]}
    products = Column(Text)  # JSON数组
    
    merchant_url = Column(String(500))
    tracking_link = Column(String(500))
    brand_name = Column(String(200))
    brand_keyword = Column(String(200))
    keyword_count = Column(Integer, default=10)
    
    # 目标国家/语言（本地化）
    target_country = Column(String(10), default="US")
    target_language = Column(String(10), default="en-US")
    
    status = Column(String(20), default="draft")  # draft/pending/approved/rejected/ready/published
    
    publish_date = Column(Date)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    published_at = Column(DateTime(timezone=True))
    
    version = Column(Integer, default=1)
    
    # 关系
    website = relationship("LuchuWebsite", back_populates="articles")
    author = relationship("User", foreign_keys=[author_id])
    versions = relationship("LuchuArticleVersion", back_populates="article")
    reviews = relationship("LuchuReview", back_populates="article")


class LuchuArticleVersion(Base):
    """文章版本历史"""
    __tablename__ = "luchu_article_versions"
    
    id = Column(Integer, primary_key=True, index=True)
    article_id = Column(Integer, ForeignKey("luchu_articles.id"), nullable=False)
    version_number = Column(Integer, nullable=False)
    title = Column(String(500))
    content = Column(Text)
    images = Column(Text)
    products = Column(Text)
    changed_by = Column(Integer, ForeignKey("users.id"))
    change_type = Column(String(50))  # create/edit/review_reject
    change_reason = Column(Text)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    # 关系
    article = relationship("LuchuArticle", back_populates="versions")
    changer = relationship("User", foreign_keys=[changed_by])


class LuchuReview(Base):
    """审核记录"""
    __tablename__ = "luchu_reviews"
    
    id = Column(Integer, primary_key=True, index=True)
    article_id = Column(Integer, ForeignKey("luchu_articles.id"), nullable=False)
    reviewer_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    status = Column(String(20), nullable=False)  # approved/rejected
    comment = Column(Text)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    # 关系
    article = relationship("LuchuArticle", back_populates="reviews")
    reviewer = relationship("User", foreign_keys=[reviewer_id])


class LuchuPublishLog(Base):
    """发布日志"""
    __tablename__ = "luchu_publish_logs"
    
    id = Column(Integer, primary_key=True, index=True)
    article_id = Column(Integer, ForeignKey("luchu_articles.id"), nullable=False)
    website_id = Column(Integer, ForeignKey("luchu_websites.id"), nullable=False)
    operator_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    commit_sha = Column(String(100))
    file_path = Column(String(200))
    status = Column(String(20))  # success/failed
    error_message = Column(Text)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    # 关系
    article = relationship("LuchuArticle", foreign_keys=[article_id])
    website = relationship("LuchuWebsite", foreign_keys=[website_id])
    operator = relationship("User", foreign_keys=[operator_id])


class LuchuImageCheck(Base):
    """图片检测记录"""
    __tablename__ = "luchu_image_checks"
    
    id = Column(Integer, primary_key=True, index=True)
    article_id = Column(Integer, ForeignKey("luchu_articles.id"), nullable=False)
    image_type = Column(String(20), nullable=False)  # hero/content_1/content_2/content_3/content_4
    url = Column(String(500), nullable=False)
    local_path = Column(String(300))
    status = Column(String(20), default="unchecked")  # valid/invalid/local/unchecked
    http_status = Column(Integer)
    last_check = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())


class LuchuImageAlert(Base):
    """图片告警"""
    __tablename__ = "luchu_image_alerts"
    
    id = Column(Integer, primary_key=True, index=True)
    article_id = Column(Integer, ForeignKey("luchu_articles.id"), nullable=False)
    website_id = Column(Integer, ForeignKey("luchu_websites.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    image_type = Column(String(20), nullable=False)
    url = Column(String(500), nullable=False)
    alert_type = Column(String(50), nullable=False)
    is_resolved = Column(Integer, default=0)
    resolved_at = Column(DateTime(timezone=True))
    resolved_by = Column(Integer, ForeignKey("users.id"))
    resolve_method = Column(String(50))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    # 关系
    article = relationship("LuchuArticle", foreign_keys=[article_id])
    website = relationship("LuchuWebsite", foreign_keys=[website_id])
    user = relationship("User", foreign_keys=[user_id])
    resolver = relationship("User", foreign_keys=[resolved_by])


class LuchuPromptTemplate(Base):
    """提示词模板"""
    __tablename__ = "luchu_prompt_templates"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    description = Column(Text)
    website_id = Column(Integer, ForeignKey("luchu_websites.id"), nullable=True)
    category = Column(String(50))
    has_products = Column(Integer, default=1)
    template_content = Column(Text, nullable=False)
    is_default = Column(Integer, default=0)
    created_by = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # 关系
    website = relationship("LuchuWebsite", foreign_keys=[website_id])
    creator = relationship("User", foreign_keys=[created_by])


class LuchuNotification(Base):
    """平台通知"""
    __tablename__ = "luchu_notifications"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    type = Column(String(50), nullable=False)
    title = Column(String(200), nullable=False)
    content = Column(Text)
    related_type = Column(String(50))
    related_id = Column(Integer)
    is_read = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    # 关系
    user = relationship("User", foreign_keys=[user_id])


class LuchuCrawlCache(Base):
    """爬取缓存"""
    __tablename__ = "luchu_crawl_cache"
    
    id = Column(Integer, primary_key=True, index=True)
    url = Column(String(500), unique=True, nullable=False)
    url_hash = Column(String(64), nullable=False)
    crawl_data = Column(Text)
    images = Column(Text)
    expires_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class LuchuOperationLog(Base):
    """操作日志"""
    __tablename__ = "luchu_operation_logs"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    action = Column(String(50), nullable=False)
    resource_type = Column(String(50), nullable=False)
    resource_id = Column(Integer)
    details = Column(Text)
    ip_address = Column(String(50))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    # 关系
    user = relationship("User", foreign_keys=[user_id])


class LuchuAnalyzeTask(Base):
    """商家分析异步任务"""
    __tablename__ = "luchu_analyze_tasks"
    
    id = Column(Integer, primary_key=True, index=True)
    task_id = Column(String(64), unique=True, nullable=False, index=True)  # UUID
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    url = Column(String(500), nullable=False)
    
    # 任务状态: pending/processing/completed/failed
    status = Column(String(20), default="pending")
    progress = Column(Integer, default=0)  # 0-100
    stage = Column(String(50))  # 当前阶段描述
    
    # 结果数据
    result_data = Column(Text)  # JSON: 分析结果
    error_message = Column(Text)  # 错误信息
    
    # 时间戳
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    started_at = Column(DateTime(timezone=True))
    completed_at = Column(DateTime(timezone=True))
    
    # 关系
    user = relationship("User", foreign_keys=[user_id])
