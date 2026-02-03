import os
from pathlib import Path
import atexit
import traceback

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

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
    collabglow,
    dashboard,
    expenses,
    export,
    google_ads_aggregate,
    google_ads_data,
    google_oauth,
    linkhaitao,
    mcc,
    platform_data,
    stage_label,
    upload,
)


app = FastAPI(title="Google Analysis Platform API")

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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 临时允许所有来源，确保CORS正常工作
    allow_credentials=False,  # 当allow_origins=["*"]时，allow_credentials必须为False
    allow_methods=["*"],  # 允许所有HTTP方法
    allow_headers=["*"],  # 允许所有请求头
    expose_headers=["*"],  # 暴露所有响应头
    max_age=3600,
)

# 辅助函数：获取CORS头（必须在CORS配置之后定义）
def get_cors_headers(origin: str = None) -> dict:
    """获取CORS响应头"""
    import re
    headers = {
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Max-Age": "3600",
    }
    
    if origin:
        # 检查origin是否在允许列表中
        if origin in ALLOWED_ORIGINS:
            headers["Access-Control-Allow-Origin"] = origin
            headers["Access-Control-Allow-Credentials"] = "true"
        elif re.match(ALLOWED_ORIGIN_REGEX, origin):
            # 使用正则表达式匹配
            headers["Access-Control-Allow-Origin"] = origin
            headers["Access-Control-Allow-Credentials"] = "true"
        else:
            # 对于google-data-analysis相关域名，也允许（更宽松的策略）
            if "google-data-analysis" in origin:
                headers["Access-Control-Allow-Origin"] = origin
                headers["Access-Control-Allow-Credentials"] = "true"
            else:
                # 开发环境：允许所有来源（仅用于调试）
                headers["Access-Control-Allow-Origin"] = "*"
    else:
        # 没有origin，允许所有（用于调试）
        headers["Access-Control-Allow-Origin"] = "*"
    
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
    
    # 检查响应头
    cors_header = response.headers.get("Access-Control-Allow-Origin")
    if origin and not cors_header:
        logger.warning(f"[CORS警告] {method} {path} 响应缺少CORS头, Origin: {origin}")
    elif origin and cors_header:
        logger.info(f"[CORS成功] {method} {path}, CORS头: {cors_header}")
    
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
    """处理所有OPTIONS请求，返回CORS头"""
    import logging
    logger = logging.getLogger(__name__)
    
    origin = request.headers.get("origin")
    headers = get_cors_headers(origin)
    
    # 添加调试日志
    logger.info(f"[CORS] OPTIONS请求: {full_path}, Origin: {origin}")
    logger.debug(f"[CORS] OPTIONS响应头: {headers}")
    
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


@app.get("/health")
async def health(request: Request):
    """健康检查端点，确保包含CORS头"""
    origin = request.headers.get("origin")
    headers = get_cors_headers(origin)
    return JSONResponse(content={"status": "ok"}, headers=headers)


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
            from fastapi.responses import JSONResponse
            origin = request.headers.get("origin")
            allowed_origins = [
                "https://google-data-analysis.top",
                "https://www.google-data-analysis.top",
                "https://api.google-data-analysis.top",
                "https://google-data-analysis.pages.dev",
            ]
            cors_origin = origin if origin in allowed_origins else None
            if not cors_origin and origin:
                import re
                if re.match(r"^https://([a-z0-9-]+\.)?google-data-analysis\.(pages\.dev|top)$", origin):
                    cors_origin = origin
            
            headers = {
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD",
                "Access-Control-Allow-Headers": "*",
            }
            if cors_origin:
                headers["Access-Control-Allow-Origin"] = cors_origin
                headers["Access-Control-Allow-Credentials"] = "true"
            else:
                headers["Access-Control-Allow-Origin"] = "*"
            
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
        print("✓ 定时任务调度器已启动")
    except Exception as e:
        import traceback
        print(f"⚠ 定时任务调度器启动失败: {e}")
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

