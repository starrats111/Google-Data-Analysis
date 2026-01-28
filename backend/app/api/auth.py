"""
认证API
"""
from datetime import timedelta
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.schemas.user import Token, UserResponse
from app.middleware.auth import (
    verify_password,
    create_access_token,
    get_current_user
)
from app.config import settings

router = APIRouter(prefix="/api/auth", tags=["auth"])

# 用户相关路由
user_router = APIRouter(prefix="/api/user", tags=["user"])


@router.post("/login", response_model=Token)
async def login(
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db)
):
    """用户登录"""
    user = db.query(User).filter(User.username == form_data.username).first()
    
    if not user or not verify_password(form_data.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    access_token_expires = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.username}, expires_delta=access_token_expires
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
    from app.models.data_upload import DataUpload
    from app.models.analysis_result import AnalysisResult
    from app.models.affiliate_account import AffiliateAccount
    from datetime import date, timedelta
    from sqlalchemy import func
    
    # 统计上传数据
    total_uploads = db.query(DataUpload).filter(
        DataUpload.user_id == current_user.id
    ).count()
    
    # 统计分析结果
    total_analyses = db.query(AnalysisResult).filter(
        AnalysisResult.user_id == current_user.id
    ).count()
    
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
    last_upload = db.query(DataUpload).filter(
        DataUpload.user_id == current_user.id
    ).order_by(DataUpload.uploaded_at.desc()).first()
    
    # 最近一次分析时间
    last_analysis = db.query(AnalysisResult).filter(
        AnalysisResult.user_id == current_user.id
    ).order_by(AnalysisResult.analysis_date.desc()).first()
    
    return {
        "total_uploads": total_uploads,
        "total_analyses": total_analyses,
        "total_accounts": total_accounts,
        "active_accounts": active_accounts,
        "today_uploads": today_uploads,
        "last_upload": last_upload.uploaded_at.isoformat() if last_upload else None,
        "last_analysis": last_analysis.analysis_date.isoformat() if last_analysis else None
    }

