#!/usr/bin/env python3
"""
诊断MCC同步问题
检查MCC账号配置和同步状态
"""
import sys
import os
from datetime import date, timedelta

# 添加项目根目录到路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.models.google_ads_api_data import GoogleMccAccount, GoogleAdsApiData
from app.config import settings

# 创建数据库会话
engine = create_engine(settings.DATABASE_URL, echo=False)
Session = sessionmaker(bind=engine)
db = Session()

def check_mcc_config(mcc_id: int):
    """检查MCC账号配置"""
    mcc = db.query(GoogleMccAccount).filter(GoogleMccAccount.id == mcc_id).first()
    
    if not mcc:
        print(f"❌ MCC账号 ID {mcc_id} 不存在")
        return None
    
    print(f"\n{'='*60}")
    print(f"MCC账号信息: {mcc.mcc_name} ({mcc.mcc_id})")
    print(f"{'='*60}")
    
    # 检查基本配置
    print(f"\n📋 基本配置:")
    print(f"  - 邮箱: {mcc.email}")
    print(f"  - 状态: {'✅ 激活' if mcc.is_active else '❌ 停用'}")
    
    # 检查API配置
    print(f"\n🔑 API配置:")
    has_client_id = bool(mcc.client_id)
    has_client_secret = bool(mcc.client_secret)
    has_refresh_token = bool(mcc.refresh_token)
    
    print(f"  - Client ID: {'✅ 已配置' if has_client_id else '❌ 未配置'}")
    print(f"  - Client Secret: {'✅ 已配置' if has_client_secret else '❌ 未配置'}")
    print(f"  - Refresh Token: {'✅ 已配置' if has_refresh_token else '❌ 未配置'}")
    
    if not (has_client_id and has_client_secret and has_refresh_token):
        print(f"\n⚠️  警告: MCC账号缺少API配置，请编辑MCC账号填写API凭证")
        return mcc
    
    # 检查系统配置
    print(f"\n⚙️  系统配置:")
    has_developer_token = bool(settings.google_ads_shared_developer_token)
    print(f"  - Developer Token: {'✅ 已配置' if has_developer_token else '❌ 未配置'}")
    
    if not has_developer_token:
        print(f"\n⚠️  警告: 系统缺少Developer Token，请在.env文件中配置GOOGLE_ADS_SHARED_DEVELOPER_TOKEN")
        return mcc
    
    # 检查已保存的数据
    data_count = db.query(GoogleAdsApiData).filter(
        GoogleAdsApiData.mcc_id == mcc.id
    ).count()
    
    print(f"\n📊 数据统计:")
    print(f"  - 已保存的数据条数: {data_count}")
    
    if data_count > 0:
        # 显示最近的数据日期
        latest_data = db.query(GoogleAdsApiData).filter(
            GoogleAdsApiData.mcc_id == mcc.id
        ).order_by(GoogleAdsApiData.date.desc()).first()
        
        if latest_data:
            print(f"  - 最新数据日期: {latest_data.date}")
    
    # 测试同步（仅检查配置，不实际同步）
    print(f"\n🧪 测试同步配置:")
    try:
        from app.services.google_ads_api_sync import GoogleAdsApiSyncService
        sync_service = GoogleAdsApiSyncService(db)
        
        # 测试昨天的数据
        test_date = date.today() - timedelta(days=1)
        print(f"  - 测试日期: {test_date}")
        print(f"  - 正在测试API连接...")
        
        result = sync_service.sync_mcc_data(mcc.id, test_date)
        
        if result.get("success"):
            saved_count = result.get("saved_count", 0)
            if saved_count > 0:
                print(f"  - ✅ 测试成功，保存了 {saved_count} 条数据")
            else:
                print(f"  - ⚠️  测试成功，但没有数据（可能该日期没有广告系列）")
        else:
            error_msg = result.get("message", "未知错误")
            print(f"  - ❌ 测试失败: {error_msg}")
            
    except Exception as e:
        print(f"  - ❌ 测试出错: {str(e)}")
        import traceback
        traceback.print_exc()
    
    return mcc

def main():
    if len(sys.argv) < 2:
        print("用法: python diagnose_mcc_sync.py <mcc_id>")
        print("示例: python diagnose_mcc_sync.py 1")
        sys.exit(1)
    
    try:
        mcc_id = int(sys.argv[1])
        check_mcc_config(mcc_id)
    except ValueError:
        print(f"❌ 无效的MCC ID: {sys.argv[1]}")
        sys.exit(1)
    except Exception as e:
        print(f"❌ 错误: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        db.close()

if __name__ == "__main__":
    main()

