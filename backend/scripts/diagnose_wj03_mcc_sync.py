#!/usr/bin/env python3
"""
诊断wj03用户的MCC同步问题
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
from app.models.user import User
from app.config import settings

# 创建数据库会话
engine = create_engine(settings.DATABASE_URL, echo=False)
Session = sessionmaker(bind=engine)
db = Session()

def diagnose_wj03_mcc_sync():
    """诊断wj03用户的MCC同步问题"""
    print("=" * 80)
    print("wj03用户MCC同步问题诊断")
    print("=" * 80)
    
    # 查找wj03用户
    user = db.query(User).filter(User.username == "wj03").first()
    
    if not user:
        print("[错误] 找不到用户 wj03")
        return
    
    print(f"\n[成功] 找到用户: {user.username} (ID: {user.id}, 角色: {user.role})")
    
    # 查找该用户的所有MCC账号
    mcc_accounts = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.user_id == user.id
    ).all()
    
    if not mcc_accounts:
        print("\n[警告] 该用户没有MCC账号")
        return
    
    print(f"\n[信息] 找到 {len(mcc_accounts)} 个MCC账号:")
    for i, mcc in enumerate(mcc_accounts, 1):
        print(f"  {i}. {mcc.mcc_name} (MCC ID: {mcc.mcc_id}, 数据库ID: {mcc.id})")
    
    # 检查每个MCC账号
    for mcc in mcc_accounts:
        print(f"\n{'='*80}")
        print(f"检查MCC账号: {mcc.mcc_name} (ID: {mcc.id})")
        print(f"{'='*80}")
        
        # 基本配置
        print(f"\n📋 基本配置:")
        print(f"  - MCC ID: {mcc.mcc_id}")
        print(f"  - MCC名称: {mcc.mcc_name}")
        print(f"  - 邮箱: {mcc.email}")
        print(f"  - 状态: {'[激活]' if mcc.is_active else '[停用]'}")
        
        if not mcc.is_active:
            print(f"\n[警告] MCC账号已停用，无法同步")
            continue
        
        # API配置检查
        print(f"\n[API配置]")
        has_client_id = bool(mcc.client_id)
        has_client_secret = bool(mcc.client_secret)
        has_refresh_token = bool(mcc.refresh_token)
        
        print(f"  - Client ID: {'[已配置]' if has_client_id else '[未配置]'}")
        if has_client_id:
            print(f"    值: {mcc.client_id[:20]}... (长度: {len(mcc.client_id)})")
        
        print(f"  - Client Secret: {'[已配置]' if has_client_secret else '[未配置]'}")
        if has_client_secret:
            print(f"    值: {'*' * 20}... (长度: {len(mcc.client_secret)})")
        
        print(f"  - Refresh Token: {'[已配置]' if has_refresh_token else '[未配置]'}")
        if has_refresh_token:
            print(f"    值: {mcc.refresh_token[:30]}... (长度: {len(mcc.refresh_token)})")
        
        if not (has_client_id and has_client_secret and has_refresh_token):
            print(f"\n[错误] MCC账号缺少API配置")
            print(f"   请编辑MCC账号，填写以下字段:")
            if not has_client_id:
                print(f"     - Client ID")
            if not has_client_secret:
                print(f"     - Client Secret")
            if not has_refresh_token:
                print(f"     - Refresh Token")
            continue
        
        # 检查系统配置
        print(f"\n[系统配置]")
        has_developer_token = bool(settings.google_ads_shared_developer_token)
        print(f"  - Developer Token: {'[已配置]' if has_developer_token else '[未配置]'}")
        
        if not has_developer_token:
            print(f"\n[错误] 系统缺少Developer Token")
            print(f"   请在.env文件中配置GOOGLE_ADS_SHARED_DEVELOPER_TOKEN")
            continue
        
        # 检查MCC ID格式
        print(f"\n[MCC ID格式检查]")
        mcc_id_clean = mcc.mcc_id.replace("-", "").strip()
        is_valid_format = mcc_id_clean.isdigit() and len(mcc_id_clean) == 10
        print(f"  - 原始MCC ID: {mcc.mcc_id}")
        print(f"  - 清理后: {mcc_id_clean}")
        print(f"  - 格式: {'[有效] 10位数字' if is_valid_format else f'[无效] 当前是{len(mcc_id_clean)}位'}")
        
        if not is_valid_format:
            print(f"\n[错误] MCC ID格式不正确")
            print(f"   MCC ID去掉横线后必须是10位数字")
            continue
        
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
        
        # 测试同步
        print(f"\n🧪 测试同步:")
        try:
            from app.services.google_ads_api_sync import GoogleAdsApiSyncService
            sync_service = GoogleAdsApiSyncService(db)
            
            # 测试昨天的数据
            test_date = date.today() - timedelta(days=1)
            print(f"  - 测试日期: {test_date}")
            print(f"  - 正在测试API连接和同步...")
            print()
            
            result = sync_service.sync_mcc_data(mcc.id, test_date)
            
            if result.get("success"):
                saved_count = result.get("saved_count", 0)
                if saved_count > 0:
                    print(f"  [成功] 测试成功，保存了 {saved_count} 条数据")
                else:
                    print(f"  [警告] 测试成功，但没有数据")
                    print(f"     可能原因:")
                    print(f"     1. 该日期没有广告系列数据")
                    print(f"     2. MCC下没有客户账号")
                    print(f"     3. 客户账号未启用")
            else:
                error_msg = result.get("message", "未知错误")
                print(f"  [失败] 测试失败: {error_msg}")
                
                # 提供解决建议
                if "缺少API配置" in error_msg:
                    print(f"\n   解决建议: 请编辑MCC账号，填写API配置")
                elif "配额" in error_msg or "quota" in error_msg.lower():
                    print(f"\n   解决建议: Google Ads API配额已耗尽，请稍后重试")
                elif "CUSTOMER_NOT_ENABLED" in error_msg:
                    print(f"\n   解决建议: MCC下的客户账号未启用，请检查Google Ads账号状态")
                elif "格式错误" in error_msg:
                    print(f"\n   解决建议: 请检查MCC ID格式是否正确（必须是10位数字）")
                else:
                    print(f"\n   解决建议: 请查看详细错误信息，检查API配置和网络连接")
                
        except Exception as e:
            print(f"  [错误] 测试出错: {str(e)}")
            import traceback
            print(f"\n   详细错误信息:")
            traceback.print_exc()
        
        print()

def main():
    try:
        diagnose_wj03_mcc_sync()
    except Exception as e:
        print(f"[错误] {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        db.close()

if __name__ == "__main__":
    main()

