#!/usr/bin/env python3
"""
诊断同步问题脚本
检查平台账号同步和MCC同步的配置和错误
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal
from app.models.affiliate_account import AffiliateAccount
from app.models.google_ads_api_data import GoogleMccAccount
from app.config import settings
import json

def check_platform_sync():
    """检查平台账号同步配置"""
    print("=" * 60)
    print("检查平台账号同步配置")
    print("=" * 60)
    
    db = SessionLocal()
    try:
        accounts = db.query(AffiliateAccount).all()
        print(f"\n找到 {len(accounts)} 个平台账号\n")
        
        for account in accounts:
            print(f"账号ID: {account.id}")
            print(f"  账号名称: {account.account_name}")
            print(f"  平台: {account.platform.platform_name} ({account.platform.platform_code})")
            print(f"  状态: {'激活' if account.is_active else '停用'}")
            
            # 检查token配置
            token_info = "未配置"
            if account.notes:
                try:
                    notes_data = json.loads(account.notes)
                    if account.platform.platform_code.lower() in ["collabglow", "cg"]:
                        token = notes_data.get("collabglow_token")
                        if token:
                            token_info = f"已配置 (长度: {len(token)})"
                    elif account.platform.platform_code.lower() in ["linkhaitao", "link-haitao", "lh"]:
                        token = notes_data.get("linkhaitao_token") or notes_data.get("token")
                        if token:
                            token_info = f"已配置 (长度: {len(token)})"
                    else:
                        token = notes_data.get("api_token")
                        if token:
                            token_info = f"已配置 (长度: {len(token)})"
                except:
                    token_info = "备注格式错误（不是JSON）"
            
            print(f"  API Token: {token_info}")
            print()
    finally:
        db.close()

def check_mcc_sync():
    """检查MCC同步配置"""
    print("=" * 60)
    print("检查MCC同步配置")
    print("=" * 60)
    
    db = SessionLocal()
    try:
        mccs = db.query(GoogleMccAccount).all()
        print(f"\n找到 {len(mccs)} 个MCC账号\n")
        
        # 检查系统配置
        print("系统配置检查:")
        developer_token = settings.google_ads_shared_developer_token
        if developer_token:
            print(f"  ✓ Developer Token: 已配置 (长度: {len(developer_token)})")
        else:
            print(f"  ✗ Developer Token: 未配置（需要在.env文件中设置GOOGLE_ADS_SHARED_DEVELOPER_TOKEN）")
        print()
        
        for mcc in mccs:
            print(f"MCC ID: {mcc.mcc_id}")
            print(f"  名称: {mcc.mcc_name}")
            print(f"  邮箱: {mcc.email}")
            print(f"  状态: {'激活' if mcc.is_active else '停用'}")
            
            # 检查API配置
            config_ok = True
            if mcc.client_id:
                print(f"  ✓ Client ID: 已配置 (长度: {len(mcc.client_id)})")
            else:
                print(f"  ✗ Client ID: 未配置")
                config_ok = False
            
            if mcc.client_secret:
                print(f"  ✓ Client Secret: 已配置 (长度: {len(mcc.client_secret)})")
            else:
                print(f"  ✗ Client Secret: 未配置")
                config_ok = False
            
            if mcc.refresh_token:
                print(f"  ✓ Refresh Token: 已配置 (长度: {len(mcc.refresh_token)})")
            else:
                print(f"  ✗ Refresh Token: 未配置")
                config_ok = False
            
            if not config_ok:
                print(f"  ⚠️  此MCC账号缺少API配置，无法同步数据")
            else:
                print(f"  ✓ 配置完整，可以同步")
            print()
    finally:
        db.close()

def check_google_ads_library():
    """检查Google Ads库是否安装"""
    print("=" * 60)
    print("检查Google Ads库")
    print("=" * 60)
    try:
        from google.ads.googleads.client import GoogleAdsClient
        print("✓ google-ads 库已安装")
    except ImportError:
        print("✗ google-ads 库未安装")
        print("  请在服务器上执行: pip install google-ads")
    print()

if __name__ == "__main__":
    print("\n" + "=" * 60)
    print("同步问题诊断工具")
    print("=" * 60 + "\n")
    
    check_google_ads_library()
    check_platform_sync()
    check_mcc_sync()
    
    print("=" * 60)
    print("诊断完成")
    print("=" * 60)

