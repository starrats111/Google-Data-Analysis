"""
Google Ads API OAuth授权
用于获取Refresh Token
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session
from typing import Optional
import requests
from urllib.parse import urlencode

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.config import settings

router = APIRouter(prefix="/api/google-oauth", tags=["google-oauth"])


@router.get("/authorize")
async def get_authorization_url(
    client_id: str = Query(..., description="Google Ads API Client ID"),
    redirect_uri: str = Query(..., description="回调URL"),
    current_user: User = Depends(get_current_user)
):
    """
    获取Google OAuth授权URL
    
    参数:
    - client_id: Google Ads API的Client ID
    - redirect_uri: 授权完成后的回调URL（必须是已配置的重定向URI）
    
    返回:
    - authorization_url: 授权URL，用户需要访问此URL完成授权
    """
    import logging
    logger = logging.getLogger(__name__)
    
    try:
        logger.info(f"用户 {current_user.username} 请求获取授权URL, client_id: {client_id[:10] if client_id else 'None'}...")
        
        # Google OAuth 2.0授权端点
        auth_url = "https://accounts.google.com/o/oauth2/v2/auth"
        
        # 构建授权参数
        params = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "https://www.googleapis.com/auth/adwords",  # Google Ads API权限范围
            "access_type": "offline",  # 必须设置为offline才能获取refresh_token
            "prompt": "consent",  # 强制显示授权页面，确保获取refresh_token
        }
        
        authorization_url = f"{auth_url}?{urlencode(params)}"
        
        logger.info(f"成功生成授权URL: {authorization_url[:100]}...")
        
        return {
            "authorization_url": authorization_url,
            "message": "请访问上面的URL完成授权，授权完成后会跳转到redirect_uri，URL参数中会包含授权码(code)"
        }
    except Exception as e:
        logger.error(f"获取授权URL失败: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"获取授权URL失败: {str(e)}"
        )


@router.get("/callback")
async def oauth_callback(
    code: str = Query(..., description="授权码"),
    client_id: str = Query(..., description="Client ID"),
    client_secret: str = Query(..., description="Client Secret"),
    redirect_uri: str = Query(..., description="回调URL"),
    current_user: User = Depends(get_current_user)
):
    """
    OAuth回调端点，用授权码换取Refresh Token
    
    参数:
    - code: 授权码（从授权URL回调中获取）
    - client_id: Google Ads API的Client ID
    - client_secret: Google Ads API的Client Secret
    - redirect_uri: 必须与授权时使用的redirect_uri一致
    
    返回:
    - refresh_token: Refresh Token
    - access_token: Access Token（临时有效）
    """
    token_url = "https://oauth2.googleapis.com/token"
    
    data = {
        "code": code,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code"
    }
    
    try:
        response = requests.post(token_url, data=data)
        response.raise_for_status()
        
        token_data = response.json()
        
        refresh_token = token_data.get("refresh_token")
        access_token = token_data.get("access_token")
        
        if not refresh_token:
            raise HTTPException(
                status_code=400,
                detail="未能获取Refresh Token。请确保在授权URL中设置了access_type=offline和prompt=consent"
            )
        
        return {
            "success": True,
            "refresh_token": refresh_token,
            "access_token": access_token,
            "expires_in": token_data.get("expires_in"),
            "message": "成功获取Refresh Token，请保存此Token到MCC账号配置中"
        }
    except requests.exceptions.RequestException as e:
        error_detail = "未知错误"
        if hasattr(e, 'response') and e.response is not None:
            try:
                error_data = e.response.json()
                error_detail = error_data.get("error_description", error_data.get("error", str(e)))
            except:
                error_detail = e.response.text or str(e)
        
        raise HTTPException(
            status_code=400,
            detail=f"获取Token失败: {error_detail}"
        )

