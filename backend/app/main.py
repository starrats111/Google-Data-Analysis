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

from app.config import settings
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
    google_oauth,
    linkhaitao,
    mcc,
    platform_data,
    reports,
    stage_label,
    system,
    team_management,
    upload,
    users,
    # 露出功能模块
    luchu_articles,
    luchu_ai,
    luchu_reviews,
    luchu_publish,
    luchu_websites,
    luchu_stats,
    luchu_notifications,
    luchu_prompts,
    luchu_logs,
    luchu_images,
)


app = FastAPI(title="Google Analysis Platform API")

# 速率限制配置
# 使用客户端 IP 作为限制键，防止单个 IP 过度请求
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

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


# 辅助函数：获取CORS头（必须在CORS配置之后定义）
def get_cors_headers(origin: str = None) -> dict:
    """获取CORS响应头
    
    安全改进: 根据请求来源动态返回对应的 Origin，而不是 "*"
    这样可以配合 allow_credentials=True 使用
    """
    import re
    
    # 默认不允许
    allowed_origin = None
    
    if origin:
        # 检查是否在白名单中
        if origin in ALLOWED_ORIGINS:
            allowed_origin = origin
        # 检查是否匹配正则表达式
        elif re.match(ALLOWED_ORIGIN_REGEX, origin):
            allowed_origin = origin
    
    headers = {
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Requested-With, Accept, Origin",
        "Access-Control-Expose-Headers": "Content-Disposition, X-Request-Id",
        "Access-Control-Max-Age": "3600",
        "Access-Control-Allow-Credentials": "true",
    }
    
    if allowed_origin:
        headers["Access-Control-Allow-Origin"] = allowed_origin
    
    return headers


# 添加请求日志中间件（用于调试CORS问题）
# 注意：中间件按添加顺序的逆序执行，所以这个中间件会在CORS中间件之后执行
@app.middleware("http")
async def cors_logging_middleware(request: Request, call_next):
    """记录CORS相关信息，用于调试"""
    import logging
    logger = logging.getLogger(__name__)
    
    origin = request.headers.get("origin")
    method = request.method
    path = request.url.path
    
    # 记录请求信息（仅记录带Origin的请求）
    if origin:
        logger.info(f"[CORS请求] {method} {path}, Origin: {origin}")
    
    # 处理请求
    response = await call_next(request)
    
    # 确保所有响应都包含CORS头（即使CORS中间件已经添加，这里作为双重保险）
    if "Access-Control-Allow-Origin" not in response.headers:
        cors_headers = get_cors_headers(origin)
        for key, value in cors_headers.items():
            response.headers[key] = value
        logger.warning(f"[CORS修复] {method} {path} 响应缺少CORS头，已添加")
    
    # 检查响应头
    cors_header = response.headers.get("Access-Control-Allow-Origin")
    if origin and not cors_header:
        logger.warning(f"[CORS警告] {method} {path} 响应缺少CORS头, Origin: {origin}")
    elif origin and cors_header:
        logger.debug(f"[CORS成功] {method} {path}, CORS头: {cors_header}")
    
    return response


# 全局异常处理器 - 确保所有错误响应都包含CORS头
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """全局异常处理器，确保所有错误都返回CORS头"""
    import traceback
    
    # 获取请求的Origin并生成CORS头
    origin = request.headers.get("origin")
    headers = get_cors_headers(origin)
    
    # 记录错误详情（用于调试）
    error_detail = str(exc)
    if hasattr(exc, "detail"):
        error_detail = exc.detail
    elif hasattr(exc, "args") and exc.args:
        error_detail = str(exc.args[0])
    
    # 打印错误到控制台（用于调试）
    print(f"❌ 全局异常捕获: {type(exc).__name__}: {error_detail}")
    traceback.print_exc()
    
    # 返回JSON响应，包含CORS头
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "detail": error_detail,
            "type": type(exc).__name__,
        },
        headers=headers,
    )


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    """HTTP异常处理器，确保包含CORS头"""
    origin = request.headers.get("origin")
    headers = get_cors_headers(origin)
    
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
        headers=headers,
    )

@app.exception_handler(HTTPException)
async def fastapi_http_exception_handler(request: Request, exc: HTTPException):
    """FastAPI HTTPException处理器，确保包含CORS头"""
    origin = request.headers.get("origin")
    headers = get_cors_headers(origin)
    
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
        headers=headers,
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """请求验证异常处理器，确保包含CORS头"""
    origin = request.headers.get("origin")
    headers = get_cors_headers(origin)
    
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": exc.errors()},
        headers=headers,
    )


# 全局OPTIONS处理器 - 确保所有OPTIONS请求都返回CORS头
# 注意：FastAPI的CORS中间件应该自动处理OPTIONS，但为了确保，我们显式添加
@app.options("/{full_path:path}")
async def options_handler(request: Request, full_path: str):
    """处理所有OPTIONS请求，返回CORS头（快速响应，避免超时）"""
    # 快速生成CORS头，不进行日志记录（避免性能问题）
    origin = request.headers.get("origin")
    headers = get_cors_headers(origin)
    
    # 使用与 CORSMiddleware 一致的配置，不用 "*"（与 credentials 冲突）
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, X-Requested-With, Accept, Origin"
    headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD"
    
    # 直接返回响应，不记录日志（提高性能）
    return JSONResponse(content={}, headers=headers, status_code=200)

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
app.include_router(google_oauth.router)
app.include_router(stage_label.router)
app.include_router(gemini.router)
app.include_router(users.router)
app.include_router(bid_management.router)
app.include_router(reports.router)
app.include_router(system.router)
app.include_router(team_management.router)

# 露出功能路由
app.include_router(luchu_articles.router)
app.include_router(luchu_ai.router)
app.include_router(luchu_reviews.router)
app.include_router(luchu_publish.router)
app.include_router(luchu_websites.router)
app.include_router(luchu_stats.router)
app.include_router(luchu_notifications.router)
app.include_router(luchu_prompts.router)
app.include_router(luchu_logs.router)
app.include_router(luchu_images.router)


@app.get("/health")
async def health(request: Request):
    """健康检查端点，确保包含CORS头"""
    try:
        origin = request.headers.get("origin")
        headers = get_cors_headers(origin)
        return JSONResponse(content={"status": "ok"}, headers=headers)
    except Exception as e:
        # 出错时也使用安全的 CORS 头（不用 "*"，与 credentials 冲突）
        origin = request.headers.get("origin")
        headers = get_cors_headers(origin) if origin else {}
        headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        return JSONResponse(
            content={"status": "error", "message": str(e)},
            headers=headers,
            status_code=500
        )


# OPTIONS请求由CORS中间件自动处理，不需要手动处理


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
            # 复用全局 ALLOWED_ORIGINS 和正则，避免重复定义
            origin = request.headers.get("origin")
            headers = get_cors_headers(origin)
            
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


@app.on_event("startup")
async def startup_event():
    """应用启动时执行"""
    try:
        start_scheduler()
        print("[OK] 定时任务调度器已启动")
    except Exception as e:
        import traceback
        print(f"[WARN] 定时任务调度器启动失败: {e}")
        print(traceback.format_exc())
        # 即使调度器启动失败，也不应该阻止应用启动
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

