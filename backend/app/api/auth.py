"""
认证API

安全改进:
- 登录接口添加速率限制（5次/分钟/IP），防止暴力破解
- 支持 Refresh Token 机制，httpOnly Cookie 存储
- logout 端点清除 Cookie
"""
from datetime import timedelta
from fastapi import APIRouter, Depends, HTTPException, status, Request, Response
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.database import get_db
from app.models.user import User
from app.schemas.user import Token, UserResponse
from app.middleware.auth import (
    verify_password,
    create_access_token,
    create_refresh_token,
    verify_refresh_token,
    get_current_user
)
from app.config import settings

# 速率限制器
limiter = Limiter(key_func=get_remote_address)

router = APIRouter(prefix="/api/auth", tags=["auth"])

# 用户相关路由
user_router = APIRouter(prefix="/api/user", tags=["user"])


@router.post("/login", response_model=Token)
@limiter.limit("5/minute")  # 登录接口: 每分钟最多 5 次，防止暴力破解
async def login(
    request: Request,  # 速率限制需要 Request 对象
    response: Response,  # 用于设置 Cookie
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db)
):
    """用户登录
    
    安全措施:
    - 速率限制: 5次/分钟/IP，防止暴力破解
    - Access Token 有效期: 24小时（通过响应体返回）
    - Refresh Token 有效期: 7天（通过 httpOnly Cookie 存储）
    """
    user = db.query(User).filter(User.username == form_data.username).first()
    
    if not user or not verify_password(form_data.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    # 创建 Access Token
    access_token_expires = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.username}, expires_delta=access_token_expires
    )
    
    # 创建 Refresh Token
    refresh_token = create_refresh_token(data={"sub": user.username})
    
    # 设置 Refresh Token 到 httpOnly Cookie
    # secure: 生产环境 True (HTTPS)，开发环境 False (HTTP)
    # domain: 设置为主域名，允许前端和API子域名共享Cookie
    is_production = settings.ENVIRONMENT == "production"
    cookie_domain = ".google-data-analysis.top" if is_production else None
    response.set_cookie(
        key="refresh_token",
        value=refresh_token,
        max_age=settings.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60,  # 秒
        path="/",
        domain=cookie_domain,  # 生产环境设置主域名，开发环境不设置
        secure=is_production,
        httponly=True,
        samesite="lax"
    )
    
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": UserResponse.model_validate(user)
    }


@router.get("/me", response_model=UserResponse)
async def get_current_user_info(
    current_user: User = Depends(get_current_user)
):
    """获取当前用户信息"""
    return UserResponse.model_validate(current_user)


@user_router.get("/statistics")
async def get_user_statistics(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取当前用户的统计数据"""
    try:
        from app.models.data_upload import DataUpload
        from app.models.analysis_result import AnalysisResult
        from app.models.affiliate_account import AffiliateAccount
        from datetime import date, timedelta
        from sqlalchemy import func
        import logging
        
        logger = logging.getLogger(__name__)
        
        # 统计上传数据
        total_uploads = db.query(DataUpload).filter(
            DataUpload.user_id == current_user.id
        ).count()
        
        # 统计分析结果（使用原始SQL避免列不存在的问题）
        try:
            total_analyses = db.query(AnalysisResult).filter(
                AnalysisResult.user_id == current_user.id
            ).count()
        except Exception as e:
            # 如果查询失败（可能是列不存在），使用原始SQL查询
            logger.warning(f"使用ORM查询分析结果失败: {e}，改用原始SQL查询")
            from sqlalchemy import text
            result = db.execute(
                text("SELECT COUNT(*) FROM analysis_results WHERE user_id = :user_id"),
                {"user_id": current_user.id}
            )
            total_analyses = result.scalar() or 0
        
        # 统计联盟账号数
        total_accounts = db.query(AffiliateAccount).filter(
            AffiliateAccount.user_id == current_user.id
        ).count()
        
        active_accounts = db.query(AffiliateAccount).filter(
            AffiliateAccount.user_id == current_user.id,
            AffiliateAccount.is_active == True
        ).count()
        
        # 今日上传数
        today_uploads = db.query(DataUpload).filter(
            DataUpload.user_id == current_user.id,
            func.date(DataUpload.uploaded_at) == date.today()
        ).count()
        
        # 最近一次上传时间
        last_upload = None
        try:
            last_upload = db.query(DataUpload).filter(
                DataUpload.user_id == current_user.id
            ).order_by(DataUpload.uploaded_at.desc()).first()
        except Exception as e:
            logger.warning(f"获取最近上传时间失败: {e}")
        
        # 最近一次分析时间
        last_analysis = None
        try:
            last_analysis = db.query(AnalysisResult).filter(
                AnalysisResult.user_id == current_user.id
            ).order_by(AnalysisResult.analysis_date.desc()).first()
        except Exception as e:
            logger.warning(f"获取最近分析时间失败: {e}")
        
        # 安全地格式化日期
        last_upload_time = None
        if last_upload and hasattr(last_upload, 'uploaded_at') and last_upload.uploaded_at:
            try:
                last_upload_time = last_upload.uploaded_at.isoformat()
            except Exception as e:
                logger.warning(f"格式化上传时间失败: {e}")
        
        last_analysis_time = None
        if last_analysis and hasattr(last_analysis, 'analysis_date') and last_analysis.analysis_date:
            try:
                last_analysis_time = last_analysis.analysis_date.isoformat()
            except Exception as e:
                logger.warning(f"格式化分析时间失败: {e}")
        
        return {
            "total_uploads": total_uploads,
            "total_analyses": total_analyses,
            "total_accounts": total_accounts,
            "active_accounts": active_accounts,
            "today_uploads": today_uploads,
            "last_upload": last_upload_time,
            "last_analysis": last_analysis_time
        }
    except Exception as e:
        import logging
        import traceback
        logger = logging.getLogger(__name__)
        logger.error(f"获取用户统计数据失败: {e}", exc_info=True)
        # 返回默认值而不是抛出异常，避免前端崩溃
        return {
            "total_uploads": 0,
            "total_analyses": 0,
            "total_accounts": 0,
            "active_accounts": 0,
            "today_uploads": 0,
            "last_upload": None,
            "last_analysis": None,
            "error": str(e)
        }


@router.post("/refresh")
@limiter.limit("10/minute")
async def refresh_token(request: Request, response: Response, db: Session = Depends(get_db)):
    """刷新 Access Token
    
    使用 httpOnly Cookie 中的 Refresh Token 获取新的 Access Token
    速率限制: 10次/分钟/IP，防止 refresh storm
    """
    # 从 Cookie 获取 Refresh Token
    refresh_token = request.cookies.get("refresh_token")
    
    if not refresh_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token not found"
        )
    
    # 验证 Refresh Token
    username = verify_refresh_token(refresh_token)
    if not username:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token"
        )
    
    # 查找用户
    user = db.query(User).filter(User.username == username).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found"
        )
    
    # 创建新的 Access Token
    access_token_expires = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    new_access_token = create_access_token(
        data={"sub": user.username}, expires_delta=access_token_expires
    )
    
    return {
        "access_token": new_access_token,
        "token_type": "bearer"
    }


@router.post("/logout")
async def logout(request: Request, response: Response):
    """用户退出登录
    
    清除 httpOnly Refresh Token Cookie
    注意：delete_cookie 的参数必须与 set_cookie 完全一致
    """
    is_production = settings.ENVIRONMENT == "production"
    cookie_domain = ".google-data-analysis.top" if is_production else None
    
    response.delete_cookie(
        key="refresh_token",
        path="/",
        domain=cookie_domain,  # 必须与 set_cookie 一致
        secure=is_production,
        httponly=True,
        samesite="lax"
    )
    
    return {"detail": "退出登录成功", "success": True}

