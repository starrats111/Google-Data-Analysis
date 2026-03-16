"""
文章发布系统模型（OPT-011）
"""
from sqlalchemy import (
    Column, Integer, String, Text, DateTime, Boolean, Float,
    ForeignKey, UniqueConstraint, Index
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class PubArticle(Base):
    __tablename__ = "pub_articles"

    id = Column(Integer, primary_key=True, autoincrement=True)
    title = Column(String(500), nullable=False)
    slug = Column(String(200), nullable=False, unique=True)
    content = Column(Text)
    excerpt = Column(Text)
    status = Column(String(20), default="draft")  # draft / published
    category_id = Column(Integer, ForeignKey("pub_categories.id"), nullable=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    author = Column(String(100))
    featured_image = Column(Text)
    publish_date = Column(DateTime)
    enable_keyword_links = Column(Boolean, default=False)
    meta_title = Column(String(200))
    meta_description = Column(String(500))
    meta_keywords = Column(String(500))
    views = Column(Integer, default=0)
    ai_model_used = Column(String(100))
    merchant_url = Column(String(500), nullable=True)
    merchant_name = Column(String(200), nullable=True)
    merchant_mid = Column(String(100), nullable=True)
    tracking_link = Column(Text, nullable=True)
    language = Column(String(10), default="zh")
    # OPT-013: 发布到网站
    site_id = Column(Integer, ForeignKey("pub_sites.id"), nullable=True)
    site_article_slug = Column(String(200), nullable=True)
    published_to_site = Column(Boolean, default=False)
    # CR-040: 图片缓存会话 ID
    image_cache_session = Column(String(50), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    deleted_at = Column(DateTime(timezone=True), nullable=True)

    category = relationship("PubCategory", back_populates="articles")
    user = relationship("User", backref="pub_articles")
    site = relationship("PubSite", backref="articles", lazy="joined")
    tags = relationship("PubArticleTag", back_populates="article", cascade="all, delete-orphan")
    links = relationship("PubArticleLink", back_populates="article", cascade="all, delete-orphan")
    images = relationship("PubArticleImage", back_populates="article", cascade="all, delete-orphan")
    versions = relationship("PubArticleVersion", back_populates="article", cascade="all, delete-orphan")

    __table_args__ = (
        Index("idx_pub_articles_schedule", "status", "publish_date"),
        Index("idx_pub_articles_user", "user_id"),
        Index("idx_pub_articles_category", "category_id"),
    )


class PubCategory(Base):
    __tablename__ = "pub_categories"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False)
    slug = Column(String(100), nullable=False, unique=True)
    description = Column(Text)
    auto_created = Column(Boolean, default=False)
    needs_review = Column(Boolean, default=False)
    confidence_score = Column(Float, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    deleted_at = Column(DateTime(timezone=True), nullable=True)

    articles = relationship("PubArticle", back_populates="category")


class PubTag(Base):
    __tablename__ = "pub_tags"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False)
    slug = Column(String(100), nullable=False, unique=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    article_tags = relationship("PubArticleTag", back_populates="tag", cascade="all, delete-orphan")


class PubArticleTag(Base):
    __tablename__ = "pub_article_tags"

    id = Column(Integer, primary_key=True, autoincrement=True)
    article_id = Column(Integer, ForeignKey("pub_articles.id"), nullable=False)
    tag_id = Column(Integer, ForeignKey("pub_tags.id"), nullable=False)
    auto_matched = Column(Boolean, default=False)
    confidence = Column(Float, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    article = relationship("PubArticle", back_populates="tags")
    tag = relationship("PubTag", back_populates="article_tags")

    __table_args__ = (
        UniqueConstraint("article_id", "tag_id", name="uq_article_tag"),
        Index("idx_pub_article_tags_article", "article_id"),
        Index("idx_pub_article_tags_tag", "tag_id"),
    )


class PubArticleLink(Base):
    __tablename__ = "pub_article_links"

    id = Column(Integer, primary_key=True, autoincrement=True)
    article_id = Column(Integer, ForeignKey("pub_articles.id"), nullable=False)
    keyword = Column(String(200), nullable=False)
    url = Column(Text, nullable=False)
    click_count = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    article = relationship("PubArticle", back_populates="links")

    __table_args__ = (
        Index("idx_pub_article_links_article", "article_id"),
    )


class PubArticleImage(Base):
    __tablename__ = "pub_article_images"

    id = Column(Integer, primary_key=True, autoincrement=True)
    article_id = Column(Integer, ForeignKey("pub_articles.id"), nullable=False)
    url = Column(Text, nullable=False)
    alt_text = Column(String(500))
    position = Column(Integer, default=0)
    source = Column(String(50))
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    article = relationship("PubArticle", back_populates="images")

    __table_args__ = (
        Index("idx_pub_article_images_article", "article_id"),
    )


class PubArticleTitle(Base):
    __tablename__ = "pub_article_titles"

    id = Column(Integer, primary_key=True, autoincrement=True)
    title = Column(String(500), nullable=False)
    title_en = Column(String(500))
    score = Column(Float, default=0)
    prompt = Column(Text)
    used = Column(Boolean, default=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User", backref="pub_article_titles")

    __table_args__ = (
        Index("idx_pub_article_titles_user", "user_id"),
    )


class PubArticleVersion(Base):
    __tablename__ = "pub_article_versions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    article_id = Column(Integer, ForeignKey("pub_articles.id"), nullable=False)
    version = Column(Integer, nullable=False, default=1)
    title = Column(String(500))
    content = Column(Text)
    changed_by = Column(String(100))
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    article = relationship("PubArticle", back_populates="versions")

    __table_args__ = (
        Index("idx_pub_article_versions_article", "article_id"),
    )
