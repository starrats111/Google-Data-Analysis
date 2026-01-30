#!/usr/bin/env python3
"""
获取Google Ads API刷新令牌的脚本

使用方法：
1. 安装依赖：pip install google-auth-oauthlib google-auth
2. 修改下面的CLIENT_ID和CLIENT_SECRET
3. 运行：python get_google_ads_refresh_token.py
4. 按照提示完成授权
5. 复制输出的刷新令牌
"""
from google_auth_oauthlib.flow import InstalledAppFlow
import json
import os

# ========== 配置信息 ==========
# 从Google Cloud Console获取
# 请修改下面的CLIENT_ID和CLIENT_SECRET为你的实际值
CLIENT_ID = os.getenv('GOOGLE_ADS_CLIENT_ID', '你的客户端ID')
CLIENT_SECRET = os.getenv('GOOGLE_ADS_CLIENT_SECRET', '你的客户端密钥')

# OAuth作用域
SCOPES = ['https://www.googleapis.com/auth/adwords']

# 重定向URI（桌面应用使用）
REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob'


def get_refresh_token():
    """获取刷新令牌"""
    print("=" * 60)
    print("Google Ads API 刷新令牌获取工具")
    print("=" * 60)
    print()
    
    if CLIENT_ID == '你的客户端ID' or CLIENT_SECRET == '你的客户端密钥':
        print("❌ 错误：请先修改脚本中的CLIENT_ID和CLIENT_SECRET")
        print()
        print("获取方法：")
        print("1. 访问 https://console.cloud.google.com/apis/credentials")
        print("2. 创建OAuth客户端ID")
        print("3. 复制客户端ID和客户端密钥")
        print()
        print("或者设置环境变量：")
        print("  set GOOGLE_ADS_CLIENT_ID=你的客户端ID")
        print("  set GOOGLE_ADS_CLIENT_SECRET=你的客户端密钥")
        return
    
    # 创建OAuth流程
    flow = InstalledAppFlow.from_client_config(
        {
            "installed": {
                "client_id": CLIENT_ID,
                "client_secret": CLIENT_SECRET,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": [REDIRECT_URI]
            }
        },
        SCOPES
    )
    
    print("正在启动授权流程...")
    print()
    
    try:
        # 获取授权（会打开浏览器）
        credentials = flow.run_local_server(port=0)
        
        print()
        print("=" * 60)
        print("✅ 授权成功！")
        print("=" * 60)
        print()
        print("请保存以下信息：")
        print()
        print(f"刷新令牌 (Refresh Token):")
        print(f"  {credentials.refresh_token}")
        print()
        print(f"客户端ID (Client ID):")
        print(f"  {CLIENT_ID}")
        print()
        print(f"客户端密钥 (Client Secret):")
        print(f"  {CLIENT_SECRET}")
        print()
        print("=" * 60)
        print()
        
        # 保存到文件（可选）
        save = input("是否保存到文件？(y/n): ").strip().lower()
        if save == 'y':
            filename = 'google_ads_credentials.json'
            with open(filename, 'w') as f:
                json.dump({
                    'refresh_token': credentials.refresh_token,
                    'client_id': CLIENT_ID,
                    'client_secret': CLIENT_SECRET,
                    'token_uri': credentials.token_uri
                }, f, indent=2)
            print(f"✅ 凭证已保存到: {filename}")
            print("⚠️  注意：请妥善保管此文件，不要提交到Git仓库！")
        
    except Exception as e:
        print()
        print("❌ 错误：", str(e))
        print()
        print("可能的解决方案：")
        print("1. 检查CLIENT_ID和CLIENT_SECRET是否正确")
        print("2. 确保已在Google Cloud Console中启用Google Ads API")
        print("3. 确保OAuth同意屏幕已配置")
        print("4. 确保已添加测试用户")


if __name__ == '__main__':
    get_refresh_token()
