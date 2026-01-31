#!/usr/bin/env python3
"""
测试MCC同步功能
直接调用同步服务，查看详细错误信息
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal
from app.models.google_ads_api_data import GoogleMccAccount
from app.services.google_ads_api_sync import GoogleAdsApiSyncService
from datetime import date, timedelta

def test_mcc_sync(mcc_id=None):
    """测试MCC同步"""
    db = SessionLocal()
    try:
        if mcc_id:
            mcc_account = db.query(GoogleMccAccount).filter(GoogleMccAccount.id == mcc_id).first()
            if not mcc_account:
                print(f"错误：找不到ID为 {mcc_id} 的MCC账号")
                return
            mccs = [mcc_account]
        else:
            mccs = db.query(GoogleMccAccount).filter(GoogleMccAccount.is_active == True).all()
        
        if not mccs:
            print("没有找到激活的MCC账号")
            return
        
        sync_service = GoogleAdsApiSyncService(db)
        
        # 同步昨天的数据
        target_date = date.today() - timedelta(days=1)
        print(f"开始测试MCC同步，目标日期: {target_date}\n")
        
        for mcc in mccs:
            print("=" * 60)
            print(f"MCC ID: {mcc.mcc_id}")
            print(f"名称: {mcc.mcc_name}")
            print(f"邮箱: {mcc.email}")
            print()
            
            # 检查配置
            if not mcc.client_id:
                print("✗ Client ID: 未配置")
            else:
                print(f"✓ Client ID: 已配置 (长度: {len(mcc.client_id)})")
            
            if not mcc.client_secret:
                print("✗ Client Secret: 未配置")
            else:
                print(f"✓ Client Secret: 已配置 (长度: {len(mcc.client_secret)})")
            
            if not mcc.refresh_token:
                print("✗ Refresh Token: 未配置")
            else:
                print(f"✓ Refresh Token: 已配置 (长度: {len(mcc.refresh_token)})")
            
            print()
            
            # 执行同步
            print(f"开始同步 {mcc.mcc_id} 的数据...")
            result = sync_service.sync_mcc_data(mcc.id, target_date)
            
            print(f"同步结果: {result.get('success')}")
            print(f"消息: {result.get('message')}")
            if result.get('saved_count') is not None:
                print(f"保存条数: {result.get('saved_count')}")
            print()
            
            if not result.get('success'):
                print(f"错误详情: {result.get('message')}")
            print()
    finally:
        db.close()

if __name__ == "__main__":
    import sys
    mcc_id = int(sys.argv[1]) if len(sys.argv) > 1 else None
    test_mcc_sync(mcc_id)

