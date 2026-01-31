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
app.add_middleware(
    CORSMiddleware,
    # 明确列出所有允许的来源（包括前端域名）
    allow_origins=[
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
    ],
    # 正则表达式匹配所有google-data-analysis相关域名和本地开发环境
    allow_origin_regex=r"^(https://([a-z0-9-]+\.)?google-data-analysis\.(pages\.dev|top)|https://www\.google-data-analysis\.top|https://api\.google-data-analysis\.top|https?://(localhost|127\.0\.0\.1)(:\d+)?)$",
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH", "HEAD"],  # 明确列出所有HTTP方法
    allow_headers=["*"],  # 允许所有请求头
    expose_headers=["*"],  # 暴露所有响应头
    max_age=3600,  # 预检请求缓存时间（秒）
)


# 全局异常处理器 - 确保所有错误响应都包含CORS头
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """全局异常处理器，确保所有错误都返回CORS头"""
    import traceback
    
    # 获取请求的Origin
    origin = request.headers.get("origin")
    allowed_origins = [
        "https://google-data-analysis.top",
        "https://www.google-data-analysis.top",
        "https://api.google-data-analysis.top",
        "https://google-data-analysis.pages.dev",
    ]
    
    # 检查origin是否在允许列表中
    cors_origin = origin if origin in allowed_origins else None
    
    # 如果是google-data-analysis相关域名，也允许
    if not cors_origin and origin:
        import re
        if re.match(r"^https://([a-z0-9-]+\.)?google-data-analysis\.(pages\.dev|top)$", origin):
            cors_origin = origin
    
    # 构建响应头 - 确保总是有CORS头
    headers = {
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD",
        "Access-Control-Allow-Headers": "*",
    }
    if cors_origin:
        headers["Access-Control-Allow-Origin"] = cors_origin
        headers["Access-Control-Allow-Credentials"] = "true"
    else:
        # 即使没有匹配的origin，也设置一个默认值（用于调试）
        headers["Access-Control-Allow-Origin"] = "*"
    
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
    
    headers = {}
    if cors_origin:
        headers["Access-Control-Allow-Origin"] = cors_origin
        headers["Access-Control-Allow-Credentials"] = "true"
        headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD"
        headers["Access-Control-Allow-Headers"] = "*"
    
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
        headers=headers,
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """请求验证异常处理器，确保包含CORS头"""
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
    
    headers = {}
    if cors_origin:
        headers["Access-Control-Allow-Origin"] = cors_origin
        headers["Access-Control-Allow-Credentials"] = "true"
        headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD"
        headers["Access-Control-Allow-Headers"] = "*"
    
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": exc.errors()},
        headers=headers,
    )

# 全局OPTIONS处理器 - 确保所有OPTIONS请求都返回CORS头
@app.options("/{full_path:path}")
async def options_handler(request: Request, full_path: str):
    """处理所有OPTIONS请求，返回CORS头"""
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
        "Access-Control-Max-Age": "3600",
    }
    if cors_origin:
        headers["Access-Control-Allow-Origin"] = cors_origin
        headers["Access-Control-Allow-Credentials"] = "true"
    
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
def health():
    return {"status": "ok"}


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
    @app.get("/{full_path:path}")
    def spa_fallback(full_path: str):
        if full_path.startswith("api/"):
            # Let API return 404 if not found
            return {"detail": "Not Found"}
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
        print(f"⚠ 定时任务调度器启动失败: {e}")


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

