import os
import logging
from pathlib import Path
import atexit
import traceback

from fastapi import FastAPI, Request, status, HTTPException
from starlette.middleware.cors import CORSMiddleware  # 直接使用 Starlette 的 CORS 中间件，避免 FastAPI 包装的兼容性问题
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

# 速率限制
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from app.config import settings, validate_critical_config
from app.services.scheduler import start_scheduler, shutdown_scheduler

# 确保日志目录存在（在导入logging_config之前）
_log_dir = Path(__file__).parent.parent / "logs"
_log_dir.mkdir(exist_ok=True)

# 初始化日志配置（静默加载，避免启动失败）
try:
    from app.logging_config import root_logger
except Exception as e:
    # 如果日志配置加载失败，使用基本配置
    import logging
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
from app.api import (
    ad_campaign,
    affiliate,
    affiliate_transactions,
    analysis,
    auth,
    bid_management,
    collabglow,
    dashboard,
    expenses,
    export,
    gemini,
    google_ads_aggregate,
    google_ads_data,
    linkhaitao,
    mcc,
    notifications,
    feedback,
    platform_data,
    reports,
    stage_label,
    system,
    team_management,
    upload,
    users,
    # 商家任务分配
    merchants,
    # 商家违规
    merchant_violations,
    # 推荐商家
    merchant_recommendations,
    # 推荐商家
    merchant_recommendations,
    # 推荐商家
    merchant_recommendations,
    # 推荐商家
    merchant_recommendations,
    # 文章发布系统（OPT-011）
    articles,
    article_gen,
    article_categories,
    article_tags,
    article_titles,
    # 网站管理（OPT-013）
    sites,
)


app = FastAPI(title="Google Analysis Platform API")

# 速率限制配置
# 使用客户端 IP 作为限制键，防止单个 IP 过度请求
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# 自定义 RateLimitExceeded 处理器（覆盖 slowapi 默认 handler，确保 429 响应包含 CORS 头）
@app.exception_handler(RateLimitExceeded)
async def custom_rate_limit_handler(request: Request, exc: RateLimitExceeded):
    origin = request.headers.get("origin")
    headers = _get_cors_headers(origin)
    return JSONResponse(
        status_code=429,
        content={"detail": f"请求过于频繁，请稍后再试。{exc.detail}"},
        headers=headers,
    )

# CORS配置 - 必须在所有路由之前添加
# 配置允许跨域请求，解决前端Cloudflare部署访问后端阿里云API的CORS问题
# 使用最宽松的配置确保所有请求都能通过，包括错误响应

# 定义允许的来源列表
ALLOWED_ORIGINS = [
        "https://google-data-analysis.top",
        "https://www.google-data-analysis.top",
        "https://api.google-data-analysis.top",
        "https://google-data-analysis.pages.dev",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
]

    # 正则表达式匹配所有google-data-analysis相关域名和本地开发环境
ALLOWED_ORIGIN_REGEX = r"^(https://([a-z0-9-]+\.)?google-data-analysis\.(pages\.dev|top)|https://www\.google-data-analysis\.top|https://api\.google-data-analysis\.top|https?://(localhost|127\.0\.0\.1)(:\d+)?)$"

# CORS配置 - 使用 Starlette 的 CORSMiddleware 直接配置
# 安全改进: 使用白名单替代 ["*"]，支持动态子域名（如 Cloudflare Pages 预览部署）
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,  # 使用白名单，不再是 ["*"]
    allow_origin_regex=ALLOWED_ORIGIN_REGEX,  # 支持动态子域名匹配
    allow_credentials=True,  # 允许携带认证信息（Cookie、Authorization）
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH", "HEAD"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With", "Accept", "Origin"],
    expose_headers=["Content-Disposition", "X-Request-Id"],
    max_age=3600,
)

# 安全头部中间件
@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    """添加安全响应头"""
    response = await call_next(request)
    
    # 防止点击劫持
    response.headers["X-Frame-Options"] = "DENY"
    
    # 防止 MIME 类型嗅探
    response.headers["X-Content-Type-Options"] = "nosniff"
    
    # XSS 过滤器（现代浏览器内置，作为额外保护层）
    response.headers["X-XSS-Protection"] = "1; mode=block"
    
    # Referrer 策略：仅在同源时发送完整 Referrer
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    
    # 权限策略：禁用不需要的浏览器功能
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    
    return response


# 辅助函数：获取CORS头（用于异常处理器，确保错误响应也包含CORS头）
def _get_cors_headers(origin: str = None) -> dict:
    """为异常响应生成 CORS 头（CORSMiddleware 不覆盖异常响应）"""
    import re

    allowed_origin = None
    if origin:
        if origin in ALLOWED_ORIGINS:
            allowed_origin = origin
        elif re.match(ALLOWED_ORIGIN_REGEX, origin):
            allowed_origin = origin

    headers = {
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Requested-With, Accept, Origin",
        "Access-Control-Allow-Credentials": "true",
    }
    if allowed_origin:
        headers["Access-Control-Allow-Origin"] = allowed_origin
    return headers


# 全局异常处理器 - 确保所有错误响应都包含CORS头
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """全局异常处理器，确保所有错误都返回CORS头"""
    import traceback as tb
    
    origin = request.headers.get("origin")
    headers = _get_cors_headers(origin)
    
    _logger = logging.getLogger(__name__)
    _logger.error(f"Unhandled exception on {request.method} {request.url.path}: {exc}", exc_info=True)
    
    if settings.ENVIRONMENT == "production":
        body = {"detail": "Internal Server Error"}
    else:
        error_detail = str(exc)
        if hasattr(exc, "detail"):
            error_detail = exc.detail
        body = {"detail": error_detail, "type": type(exc).__name__}
    
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content=body,
        headers=headers,
    )


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    """HTTP异常处理器，确保包含CORS头"""
    origin = request.headers.get("origin")
    headers = _get_cors_headers(origin)
    
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
        headers=headers,
    )

@app.exception_handler(HTTPException)
async def fastapi_http_exception_handler(request: Request, exc: HTTPException):
    """FastAPI HTTPException处理器，确保包含CORS头"""
    origin = request.headers.get("origin")
    headers = _get_cors_headers(origin)
    
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
        headers=headers,
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """请求验证异常处理器，确保包含CORS头"""
    origin = request.headers.get("origin")
    headers = _get_cors_headers(origin)
    
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": exc.errors()},
        headers=headers,
    )



# API routes
app.include_router(auth.router)
app.include_router(auth.user_router)
app.include_router(upload.router)
app.include_router(analysis.router)
app.include_router(dashboard.router)
app.include_router(expenses.router)
app.include_router(export.router)
app.include_router(ad_campaign.router)
app.include_router(affiliate.router)
app.include_router(affiliate_transactions.router)
app.include_router(collabglow.router)
app.include_router(linkhaitao.router)
app.include_router(mcc.router)
app.include_router(platform_data.router)
app.include_router(google_ads_data.router)
app.include_router(google_ads_aggregate.router)
app.include_router(stage_label.router)
app.include_router(gemini.router)
app.include_router(users.router)
app.include_router(bid_management.router)
app.include_router(reports.router)
app.include_router(system.router)
app.include_router(team_management.router)
app.include_router(notifications.router)
app.include_router(feedback.router)

# 商家任务分配路由
app.include_router(merchants.router)
app.include_router(merchants.assignment_router)
app.include_router(merchants.performance_router)
app.include_router(merchant_violations.router)
app.include_router(merchant_recommendations.router)
app.include_router(merchant_recommendations.router)
app.include_router(merchant_recommendations.router)
app.include_router(merchant_recommendations.router)



# 文章发布系统路由（OPT-011）
app.include_router(articles.router)
app.include_router(article_gen.router)
app.include_router(article_categories.router)
app.include_router(article_tags.router)
app.include_router(article_titles.router)

# 网站管理路由（OPT-013）
app.include_router(sites.router)

# 广告创建路由（CR-039）
from app.api import ad_creation
app.include_router(ad_creation.router)

# 节日营销路由
from app.api import holidays
app.include_router(holidays.router)


@app.get("/health")
async def health():
    """健康检查端点"""
    return {"status": "ok"}



@app.get("/")
def root():
    return {"message": "Google Analysis backend is running", "docs": "/docs"}


# Optional: serve built frontend (Vite) if present.
# Put build output at `frontend/dist` (or copy it to `backend/frontend_dist`) in deployment.
_repo_root = Path(__file__).resolve().parents[2]
_dist_candidates = [
    _repo_root / "frontend" / "dist",
    _repo_root / "backend" / "frontend_dist",
]
_dist_dir = next((p for p in _dist_candidates if p.exists() and p.is_dir()), None)

if _dist_dir:
    app.mount("/", StaticFiles(directory=str(_dist_dir), html=True), name="frontend")

    # SPA fallback: any non-API route -> index.html
    # 重要：这个路由必须在所有API路由之后注册，且不能拦截/api/路径
    @app.get("/{full_path:path}")
    async def spa_fallback(request: Request, full_path: str):
        # 确保API路由不被拦截
        if full_path.startswith("api/"):
            # 让API路由处理，返回404
            origin = request.headers.get("origin")
            headers = _get_cors_headers(origin)
            
            return JSONResponse(
                status_code=404,
                content={"detail": "Not Found"},
                headers=headers
            )
        
        # 非API路径，返回前端页面
        index_path = _dist_dir / "index.html"
        if index_path.exists():
            return FileResponse(str(index_path))
        return {"detail": "Frontend not built"}


def _ensure_notification_columns():
    """SQLite 兼容：为 notifications 表补齐 sender_id / reply_to_id 列。"""
    from app.database import engine
    from sqlalchemy import text, inspect as sa_inspect
    insp = sa_inspect(engine)
    existing = {c["name"] for c in insp.get_columns("notifications")}
    with engine.begin() as conn:
        if "sender_id" not in existing:
            conn.execute(text("ALTER TABLE notifications ADD COLUMN sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL"))
        if "reply_to_id" not in existing:
            conn.execute(text("ALTER TABLE notifications ADD COLUMN reply_to_id INTEGER"))


def _ensure_site_tables():
    """OPT-013: 创建 pub_sites 表 + pub_articles 新增 site 相关列。"""
    from app.database import engine
    from sqlalchemy import text, inspect as sa_inspect
    insp = sa_inspect(engine)
    existing_tables = insp.get_table_names()

    with engine.begin() as conn:
        if "pub_sites" not in existing_tables:
            conn.execute(text("""
                CREATE TABLE pub_sites (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    group_id INTEGER NOT NULL,
                    site_name VARCHAR(100) NOT NULL,
                    site_path VARCHAR(300) NOT NULL,
                    domain VARCHAR(200),
                    data_js_path VARCHAR(200) DEFAULT 'js/articles-index.js',
                    article_template VARCHAR(200) DEFAULT 'article-1.html',
                    migrated BOOLEAN DEFAULT 0,
                    created_by INTEGER NOT NULL REFERENCES users(id),
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            """))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_pub_sites_group ON pub_sites(group_id)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_pub_sites_creator ON pub_sites(created_by)"))

    if "pub_articles" in existing_tables:
        article_cols = {c["name"] for c in insp.get_columns("pub_articles")}
        with engine.begin() as conn:
            if "site_id" not in article_cols:
                conn.execute(text("ALTER TABLE pub_articles ADD COLUMN site_id INTEGER REFERENCES pub_sites(id)"))
            if "site_article_slug" not in article_cols:
                conn.execute(text("ALTER TABLE pub_articles ADD COLUMN site_article_slug VARCHAR(200)"))
            if "published_to_site" not in article_cols:
                conn.execute(text("ALTER TABLE pub_articles ADD COLUMN published_to_site BOOLEAN DEFAULT 0"))


def _ensure_merchant_columns():
    """OPT-014: 为 affiliate_merchants 表补齐 last_seen_at / consecutive_misses / violation / recommendation 列。"""
    from app.database import engine
    from sqlalchemy import text, inspect as sa_inspect
    insp = sa_inspect(engine)
    existing = {c["name"] for c in insp.get_columns("affiliate_merchants")}
    with engine.begin() as conn:
        if "last_seen_at" not in existing:
            conn.execute(text("ALTER TABLE affiliate_merchants ADD COLUMN last_seen_at DATETIME"))
        if "consecutive_misses" not in existing:
            conn.execute(text("ALTER TABLE affiliate_merchants ADD COLUMN consecutive_misses INTEGER DEFAULT 0 NOT NULL"))
        if "violation_status" not in existing:
            conn.execute(text("ALTER TABLE affiliate_merchants ADD COLUMN violation_status VARCHAR(20) DEFAULT 'normal' NOT NULL"))
        if "violation_time" not in existing:
            conn.execute(text("ALTER TABLE affiliate_merchants ADD COLUMN violation_time DATETIME"))
        if "recommendation_status" not in existing:
            conn.execute(text("ALTER TABLE affiliate_merchants ADD COLUMN recommendation_status VARCHAR(20) DEFAULT 'normal' NOT NULL"))
        if "recommendation_time" not in existing:
            conn.execute(text("ALTER TABLE affiliate_merchants ADD COLUMN recommendation_time DATETIME"))
        if "recommendation_status" not in existing:
            conn.execute(text("ALTER TABLE affiliate_merchants ADD COLUMN recommendation_status VARCHAR(20) DEFAULT 'normal' NOT NULL"))
        if "recommendation_time" not in existing:
            conn.execute(text("ALTER TABLE affiliate_merchants ADD COLUMN recommendation_time DATETIME"))


def _ensure_violation_table():
    """创建 merchant_violations 表。"""
    from app.database import engine
    from sqlalchemy import text, inspect as sa_inspect
    insp = sa_inspect(engine)
    if "merchant_violations" not in insp.get_table_names():
        with engine.begin() as conn:
            conn.execute(text("""
                CREATE TABLE merchant_violations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    mcid VARCHAR(200),
                    merchant_mid VARCHAR(64),
                    merchant_name VARCHAR(200) NOT NULL,
                    platform VARCHAR(32) NOT NULL,
                    merchant_url VARCHAR(500),
                    violation_time DATETIME,
                    upload_batch VARCHAR(64) NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            """))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_violation_mcid_platform ON merchant_violations(mcid, platform)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_violation_mid_platform ON merchant_violations(merchant_mid, platform)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_violation_batch ON merchant_violations(upload_batch)"))


def _ensure_recommendation_table():
    """创建 merchant_recommendations 表。"""
    from app.database import engine
    from sqlalchemy import text, inspect as sa_inspect
    insp = sa_inspect(engine)
    if "merchant_recommendations" not in insp.get_table_names():
        with engine.begin() as conn:
            conn.execute(text("""
                CREATE TABLE merchant_recommendations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    mcid VARCHAR(200),
                    merchant_mid VARCHAR(64),
                    merchant_name VARCHAR(200) NOT NULL,
                    platform VARCHAR(32),
                    merchant_url VARCHAR(500),
                    merchant_region VARCHAR(100),
                    epc DECIMAL(12,4),
                    commission_cap DECIMAL(12,4),
                    avg_commission_rate DECIMAL(12,10),
                    avg_order_commission DECIMAL(12,4),
                    upload_batch VARCHAR(64) NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            """))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_recommend_mcid ON merchant_recommendations(mcid)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_recommend_mid ON merchant_recommendations(merchant_mid)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_recommend_batch ON merchant_recommendations(upload_batch)"))


def _ensure_recommendation_table():
    """创建 merchant_recommendations 表。"""
    from app.database import engine
    from sqlalchemy import text, inspect as sa_inspect
    insp = sa_inspect(engine)
    if "merchant_recommendations" not in insp.get_table_names():
        with engine.begin() as conn:
            conn.execute(text("""
                CREATE TABLE merchant_recommendations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    mcid VARCHAR(200),
                    merchant_mid VARCHAR(64),
                    merchant_name VARCHAR(200) NOT NULL,
                    platform VARCHAR(32),
                    merchant_url VARCHAR(500),
                    merchant_region VARCHAR(100),
                    epc DECIMAL(12,4),
                    commission_cap DECIMAL(12,4),
                    avg_commission_rate DECIMAL(12,10),
                    avg_order_commission DECIMAL(12,4),
                    upload_batch VARCHAR(64) NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            """))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_recommend_mcid ON merchant_recommendations(mcid)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_recommend_mid ON merchant_recommendations(merchant_mid)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS idx_recommend_batch ON merchant_recommendations(upload_batch)"))


@app.on_event("startup")
async def startup_event():
    """应用启动时执行"""
    validate_critical_config()
    try:
        _ensure_notification_columns()
    except Exception as e:
        print(f"[WARN] 补齐 notification 列失败（首次部署可忽略）: {e}")
    try:
        _ensure_merchant_columns()
    except Exception as e:
        print(f"[WARN] 补齐 merchant 列失败（首次部署可忽略）: {e}")
    try:
        _ensure_violation_table()
    except Exception as e:
        print(f"[WARN] 创建 merchant_violations 表失败（首次部署可忽略）: {e}")
    try:
        _ensure_recommendation_table()
    except Exception as e:
        print(f"[WARN] 创建 merchant_recommendations 表失败（首次部署可忽略）: {e}")
    try:
        _ensure_recommendation_table()
    except Exception as e:
        print(f"[WARN] 创建 merchant_recommendations 表失败（首次部署可忽略）: {e}")
    try:
        _ensure_site_tables()
        print("[OK] OPT-013 pub_sites 表已就绪")
    except Exception as e:
        print(f"[WARN] OPT-013 pub_sites 建表失败（首次部署可忽略）: {e}")
    try:
        start_scheduler()
        print("[OK] 定时任务调度器已启动")
    except Exception as e:
        import traceback
        print(f"[WARN] 定时任务调度器启动失败: {e}")
        print(traceback.format_exc())
        logger = logging.getLogger(__name__)
        logger.error(f"定时任务调度器启动失败: {e}", exc_info=True)


@app.on_event("shutdown")
async def shutdown_event():
    """应用关闭时执行"""
    try:
        shutdown_scheduler()
        print("✓ 定时任务调度器已关闭")
    except Exception as e:
        print(f"⚠ 定时任务调度器关闭失败: {e}")


# 注册退出时的清理函数
atexit.register(shutdown_scheduler)

