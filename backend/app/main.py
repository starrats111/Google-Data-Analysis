import os
from pathlib import Path
import atexit

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.scheduler import start_scheduler, shutdown_scheduler
from app.api import (
    ad_campaign,
    affiliate,
    analysis,
    auth,
    collabglow,
    dashboard,
    expenses,
    export,
    linkhaitao,
    mcc,
    stage_label,
    upload,
)


app = FastAPI(title="Google Analysis Platform API")

# CORS配置 - 支持所有google-data-analysis.top的子域名
cors_origins = getattr(settings, "CORS_ORIGINS", []) or []
if not cors_origins or cors_origins == ["*"]:
    cors_origins = [
        "https://google-data-analysis.top",
        "https://api.google-data-analysis.top",
        "https://www.google-data-analysis.top",
        "https://google-data-analysis.pages.dev",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    # 允许所有google-data-analysis.top的子域名
    allow_origin_regex=r"^(https://([a-z0-9-]+\.)?google-data-analysis\.(pages\.dev|top)|https?://(localhost|127\.0\.0\.1)(:\d+)?)$",
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allow_headers=["*"],
    expose_headers=["*"],
    max_age=3600,
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


# 启动定时任务
@app.on_event("startup")
async def startup_event():
    """应用启动时执行"""
    start_scheduler()

@app.on_event("shutdown")
async def shutdown_event():
    """应用关闭时执行"""
    shutdown_scheduler()

# 注册退出时的清理函数
atexit.register(shutdown_scheduler)

