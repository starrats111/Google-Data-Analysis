"""
FastAPI应用主文件
"""
import logging
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from starlette.middleware.base import BaseHTTPMiddleware
from app.config import settings
from app.api import auth, upload, analysis, affiliate, dashboard, export, stage_label, ad_campaign, expenses
from app.api.auth import user_router

# 配置日志
try:
    from app.logging_config import root_logger
    logger = logging.getLogger(__name__)
    logger.info("日志系统已初始化")
except Exception as e:
    # 如果日志配置失败，使用基本配置
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    logger = logging.getLogger(__name__)
    logger.warning(f"使用基本日志配置: {e}")

app = FastAPI(
    title="谷歌广告数据分析平台",
    description="自动化处理谷歌广告中心和联盟平台的数据分析工作",
    version="1.0.0"
)

# CORS配置 - 允许所有来源（开发环境）
# 生产环境应该限制为特定域名
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],  # 明确指定前端地址
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allow_headers=["*"],
    expose_headers=["*"],
    max_age=3600,
)

# 注册路由
app.include_router(auth.router)
app.include_router(user_router)  # 用户统计路由
app.include_router(affiliate.router)
app.include_router(upload.router)
app.include_router(analysis.router)
app.include_router(dashboard.router)
app.include_router(export.router)
app.include_router(stage_label.router)
app.include_router(ad_campaign.router)  # 广告系列路由
app.include_router(expenses.router)  # 我的费用路由


@app.get("/")
async def root():
    """根路径"""
    return {
        "message": "谷歌广告数据分析平台API",
        "version": "1.0.0",
        "docs": "/docs"
    }


@app.get("/health")
async def health_check():
    """健康检查"""
    return {"status": "healthy"}


@app.middleware("http")
async def add_cors_header(request: Request, call_next):
    """添加CORS头到所有响应"""
    # 处理OPTIONS预检请求
    if request.method == "OPTIONS":
        response = Response()
        origin = request.headers.get("origin")
        if origin in ["http://localhost:3000", "http://127.0.0.1:3000"]:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS, PATCH"
        response.headers["Access-Control-Allow-Headers"] = "*"
        response.headers["Access-Control-Max-Age"] = "3600"
        return response
    
    # 处理其他请求
    response = await call_next(request)
    origin = request.headers.get("origin")
    if origin in ["http://localhost:3000", "http://127.0.0.1:3000"]:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS, PATCH"
    response.headers["Access-Control-Allow-Headers"] = "*"
    response.headers["Access-Control-Expose-Headers"] = "*"
    return response




