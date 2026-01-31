import os
from pathlib import Path
import atexit

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.services.scheduler import start_scheduler, shutdown_scheduler
from app.api import (
    ad_campaign,
    affiliate,
    analysis,
    auth,
    collabglow,
    dashboard,
    expenses,
    export,
    google_ads_data,
    google_oauth,
    linkhaitao,
    mcc,
    platform_data,
    stage_label,
    upload,
)


app = FastAPI(title="Google Analysis Platform API")

# CORS (开发环境默认；生产环境建议在 .env 里覆盖 CORS_ORIGINS)
cors_origins = getattr(settings, "CORS_ORIGINS", ["*"]) or ["*"]

# 如果CORS_ORIGINS是["*"]，使用默认列表
if cors_origins == ["*"]:
    default_origins = [
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
else:
    default_origins = cors_origins

app.add_middleware(
    CORSMiddleware,
    allow_origins=default_origins,
    # Allow Cloudflare Pages preview subdomains and production domains:
    # - https://google-data-analysis.pages.dev
    # - https://<hash>.google-data-analysis.pages.dev
    # - https://google-data-analysis.top
    # - https://www.google-data-analysis.top
    # - https://api.google-data-analysis.top
    # - https://*.google-data-analysis.top
    # And allow local dev origins:
    # - http://localhost:5173 / http://127.0.0.1:5173 (any port)
    # 允许所有 google-data-analysis.top 的子域名和主域名
    allow_origin_regex=r"^(https://([a-z0-9-]+\.)?google-data-analysis\.(pages\.dev|top)|https://www\.google-data-analysis\.top|https://api\.google-data-analysis\.top|https?://(localhost|127\.0\.0\.1)(:\d+)?)$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
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
app.include_router(collabglow.router)
app.include_router(linkhaitao.router)
app.include_router(mcc.router)
app.include_router(platform_data.router)
app.include_router(google_ads_data.router)
app.include_router(google_oauth.router)
app.include_router(stage_label.router)


@app.get("/health")
def health():
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

