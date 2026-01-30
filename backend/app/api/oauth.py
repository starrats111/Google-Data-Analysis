"""
Google OAuth 获取刷新令牌的API
"""
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import HTMLResponse, RedirectResponse
from google_auth_oauthlib.flow import Flow
from google.auth.transport.requests import Request
import os
from urllib.parse import urlencode
from app.config import settings

router = APIRouter(prefix="/api/oauth", tags=["oauth"])

# OAuth作用域
SCOPES = ['https://www.googleapis.com/auth/adwords']

# 重定向URI（使用服务器地址）
# 注意：需要在Google Cloud Console中配置这个重定向URI
REDIRECT_URI = os.getenv('OAUTH_REDIRECT_URI', 'https://api.google-data-analysis.top/api/oauth/callback')


@router.get("/authorize")
async def get_authorize_url(
    client_id: str = Query(..., description="客户端ID"),
    client_secret: str = Query(..., description="客户端密钥")
):
    """
    获取授权URL
    员工访问这个URL，完成授权后会重定向到回调页面
    """
    try:
        # 创建OAuth流程
        flow = Flow.from_client_config(
            {
                "web": {
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                    "redirect_uris": [REDIRECT_URI]
                }
            },
            scopes=SCOPES,
            redirect_uri=REDIRECT_URI
        )
        
        # 生成授权URL
        authorization_url, state = flow.authorization_url(
            access_type='offline',
            include_granted_scopes='true',
            prompt='consent'  # 强制显示同意屏幕，确保获取刷新令牌
        )
        
        return {
            "authorization_url": authorization_url,
            "state": state,
            "instructions": "请在浏览器中打开上面的URL，完成授权后，复制显示的授权码"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"生成授权URL失败: {str(e)}")


@router.get("/callback")
async def oauth_callback(
    code: str = Query(None, description="授权码"),
    state: str = Query(None, description="状态参数"),
    error: str = Query(None, description="错误信息")
):
    """
    OAuth回调处理
    如果成功，显示刷新令牌
    如果失败，显示错误信息
    """
    if error:
        return HTMLResponse(content=f"""
        <html>
        <head><title>授权失败</title></head>
        <body>
            <h1>❌ 授权失败</h1>
            <p>错误信息：{error}</p>
            <p><a href="/oauth-tool">返回重试</a></p>
        </body>
        </html>
        """)
    
    if not code:
        return HTMLResponse(content="""
        <html>
        <head><title>授权失败</title></head>
        <body>
            <h1>❌ 未收到授权码</h1>
            <p>请重新尝试授权</p>
            <p><a href="/oauth-tool">返回重试</a></p>
        </body>
        </html>
        """)
    
    return HTMLResponse(content=f"""
    <html>
    <head>
        <title>授权成功</title>
        <style>
            body {{
                font-family: Arial, sans-serif;
                max-width: 800px;
                margin: 50px auto;
                padding: 20px;
            }}
            .success {{
                background: #d4edda;
                border: 1px solid #c3e6cb;
                padding: 20px;
                border-radius: 5px;
                margin: 20px 0;
            }}
            .code {{
                background: #f8f9fa;
                padding: 15px;
                border-radius: 5px;
                font-family: monospace;
                word-break: break-all;
                margin: 10px 0;
            }}
            button {{
                background: #007bff;
                color: white;
                border: none;
                padding: 10px 20px;
                border-radius: 5px;
                cursor: pointer;
                margin: 5px;
            }}
            button:hover {{
                background: #0056b3;
            }}
        </style>
    </head>
    <body>
        <h1>✅ 授权成功！</h1>
        <div class="success">
            <p>请复制下面的授权码，然后返回工具页面获取刷新令牌：</p>
            <div class="code" id="authCode">{code}</div>
            <button onclick="copyCode()">复制授权码</button>
        </div>
        <p><a href="/oauth-tool">返回工具页面</a></p>
        <script>
            function copyCode() {{
                const code = document.getElementById('authCode').textContent;
                navigator.clipboard.writeText(code).then(() => {{
                    alert('授权码已复制到剪贴板！');
                }});
            }}
        </script>
    </body>
    </html>
    """)


@router.post("/exchange")
async def exchange_code_for_token(
    code: str = Query(..., description="授权码"),
    client_id: str = Query(..., description="客户端ID"),
    client_secret: str = Query(..., description="客户端密钥")
):
    """
    使用授权码交换刷新令牌
    """
    try:
        # 使用桌面应用的重定向URI
        redirect_uri = 'urn:ietf:wg:oauth:2.0:oob'
        
        # 创建OAuth流程
        flow = Flow.from_client_config(
            {
                "installed": {
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                    "redirect_uris": [redirect_uri]
                }
            },
            scopes=SCOPES,
            redirect_uri=redirect_uri
        )
        
        # 使用授权码获取令牌
        flow.fetch_token(code=code)
        
        credentials = flow.credentials
        
        if not credentials.refresh_token:
            raise HTTPException(
                status_code=400,
                detail="未获取到刷新令牌。请确保在授权时选择了'离线访问'，并重新授权。"
            )
        
        return {
            "success": True,
            "refresh_token": credentials.refresh_token,
            "client_id": client_id,
            "client_secret": client_secret,
            "message": "刷新令牌获取成功！请保存这些信息。"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"交换令牌失败: {str(e)}")

