"""
网站发布配置模型（OPT-013 / CR-037）
"""
from sqlalchemy import (
    Column, Integer, String, Boolean, DateTime, ForeignKey, Index
)
from sqlalchemy.sql import func
from app.database import Base


# 网站架构类型常量
SITE_TYPE_POSTS_ASSETS_JS = "posts_assets_js"      # A1: assets/js/main.js + const posts
SITE_TYPE_POSTS_ASSETS = "posts_assets"              # A2: assets/main.js + const posts
SITE_TYPE_ARTICLES_INDEX = "articles_index"           # B1: js/articles-index.js + articlesIndex
SITE_TYPE_ARTICLES_INLINE = "articles_inline"         # B2: js/main.js + const articles/articlesData
SITE_TYPE_ARTICLES_DATA_WINDOW = "articles_data_win"  # C1: articles-data.js + window.__ARTICLES__
SITE_TYPE_BLOGPOSTS_DATA = "blogposts_data"           # C2: data.js + const blogPosts
SITE_TYPE_POSTS_SCRIPTS = "posts_scripts"             # D:  scripts.js + const POSTS


class PubSite(Base):
    __tablename__ = "pub_sites"

    id = Column(Integer, primary_key=True, autoincrement=True)
    group_id = Column(Integer, nullable=False)
    site_name = Column(String(100), nullable=False)
    site_path = Column(String(300), nullable=False)
    domain = Column(String(200), nullable=True)
    site_type = Column(String(30), nullable=True)                          # CR-037: 架构类型
    data_js_path = Column(String(200), default="js/articles-index.js")     # 数据文件相对路径
    article_var_name = Column(String(100), nullable=True)                  # CR-037: JS 变量名
    article_html_pattern = Column(String(100), nullable=True)              # CR-037: 文章HTML命名模式
    article_template = Column(String(200), default="article-1.html")
    migrated = Column(Boolean, default=False)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        Index("idx_pub_sites_group", "group_id"),
        Index("idx_pub_sites_creator", "created_by"),
    )
