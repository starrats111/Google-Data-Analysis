#!/usr/bin/env python3
"""
07的强制同步脚本 - 同步所有MCC账号最近7天的数据
"""
import sys
from pathlib import Path
from datetime import date, timedelta

# 添加backend目录到路径
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

from app.database import SessionLocal
from app.services.google_ads_api_sync import GoogleAdsApiSyncService
from app.models.google_ads_api_data import GoogleMccAccount

def sync_all_mcc():
    """同步所有MCC账号最近7天的数据"""
    db = SessionLocal()
    
    try:
        print("=== 07的强制同步 ===")
        print("")
        
        # 同步最近7天的数据
        today = date.today()
        sync_dates = [today - timedelta(days=i+1) for i in range(7)]
        
        print(f"同步日期范围: {sync_dates[-1].isoformat()} ~ {sync_dates[0].isoformat()}")
        print("")
        
        # 获取所有激活的MCC账号
        mcc_accounts = db.query(GoogleMccAccount).filter(
            GoogleMccAccount.is_active == True
        ).all()
        
        print(f"找到 {len(mcc_accounts)} 个MCC账号")
        print("")
        
        sync_service = GoogleAdsApiSyncService(db)
        
        total_saved = 0
        total_errors = 0
        
        for mcc in mcc_accounts:
            print(f"MCC: {mcc.mcc_name} ({mcc.mcc_id})")
            
            mcc_saved = 0
            mcc_errors = 0
            
            for sync_date in sync_dates:
                try:
                    result = sync_service.sync_mcc_data(mcc.id, sync_date, force_refresh=True)
                    
                    if result.get("success"):
                        saved = result.get("saved_count", 0)
                        if saved > 0:
                            mcc_saved += saved
                            print(f"  ✅ {sync_date.isoformat()}: {saved} 条")
                        elif result.get("skipped"):
                            print(f"  ⏭️  {sync_date.isoformat()}: 已存在")
                        else:
                            print(f"  ⚠️  {sync_date.isoformat()}: 0 条（可能无数据）")
                    else:
                        error_msg = result.get("message", "未知错误")
                        if "配额" in error_msg or "quota" in error_msg.lower():
                            print(f"  ❌ {sync_date.isoformat()}: 配额限制，停止同步")
                            break
                        else:
                            print(f"  ❌ {sync_date.isoformat()}: {error_msg}")
                            mcc_errors += 1
                    
                    # 延迟0.5秒，避免请求过快
                    import time
                    time.sleep(0.5)
                    
                except Exception as e:
                    print(f"  ❌ {sync_date.isoformat()}: {str(e)}")
                    mcc_errors += 1
            
            if mcc_saved > 0:
                print(f"  📊 本MCC共保存: {mcc_saved} 条")
            print("")
            
            total_saved += mcc_saved
            total_errors += mcc_errors
        
        print("=== 同步完成 ===")
        print(f"总保存: {total_saved} 条数据")
        if total_errors > 0:
            print(f"总错误: {total_errors} 个")
        print("")
        print("✅ 请刷新前端页面查看更新后的费用")
        
    except Exception as e:
        print(f"❌ 同步失败: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()

if __name__ == "__main__":
    sync_all_mcc()


"""
07的强制同步脚本 - 同步所有MCC账号最近7天的数据
"""
import sys
from pathlib import Path
from datetime import date, timedelta

# 添加backend目录到路径
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

from app.database import SessionLocal
from app.services.google_ads_api_sync import GoogleAdsApiSyncService
from app.models.google_ads_api_data import GoogleMccAccount

def sync_all_mcc():
    """同步所有MCC账号最近7天的数据"""
    db = SessionLocal()
    
    try:
        print("=== 07的强制同步 ===")
        print("")
        
        # 同步最近7天的数据
        today = date.today()
        sync_dates = [today - timedelta(days=i+1) for i in range(7)]
        
        print(f"同步日期范围: {sync_dates[-1].isoformat()} ~ {sync_dates[0].isoformat()}")
        print("")
        
        # 获取所有激活的MCC账号
        mcc_accounts = db.query(GoogleMccAccount).filter(
            GoogleMccAccount.is_active == True
        ).all()
        
        print(f"找到 {len(mcc_accounts)} 个MCC账号")
        print("")
        
        sync_service = GoogleAdsApiSyncService(db)
        
        total_saved = 0
        total_errors = 0
        
        for mcc in mcc_accounts:
            print(f"MCC: {mcc.mcc_name} ({mcc.mcc_id})")
            
            mcc_saved = 0
            mcc_errors = 0
            
            for sync_date in sync_dates:
                try:
                    result = sync_service.sync_mcc_data(mcc.id, sync_date, force_refresh=True)
                    
                    if result.get("success"):
                        saved = result.get("saved_count", 0)
                        if saved > 0:
                            mcc_saved += saved
                            print(f"  ✅ {sync_date.isoformat()}: {saved} 条")
                        elif result.get("skipped"):
                            print(f"  ⏭️  {sync_date.isoformat()}: 已存在")
                        else:
                            print(f"  ⚠️  {sync_date.isoformat()}: 0 条（可能无数据）")
                    else:
                        error_msg = result.get("message", "未知错误")
                        if "配额" in error_msg or "quota" in error_msg.lower():
                            print(f"  ❌ {sync_date.isoformat()}: 配额限制，停止同步")
                            break
                        else:
                            print(f"  ❌ {sync_date.isoformat()}: {error_msg}")
                            mcc_errors += 1
                    
                    # 延迟0.5秒，避免请求过快
                    import time
                    time.sleep(0.5)
                    
                except Exception as e:
                    print(f"  ❌ {sync_date.isoformat()}: {str(e)}")
                    mcc_errors += 1
            
            if mcc_saved > 0:
                print(f"  📊 本MCC共保存: {mcc_saved} 条")
            print("")
            
            total_saved += mcc_saved
            total_errors += mcc_errors
        
        print("=== 同步完成 ===")
        print(f"总保存: {total_saved} 条数据")
        if total_errors > 0:
            print(f"总错误: {total_errors} 个")
        print("")
        print("✅ 请刷新前端页面查看更新后的费用")
        
    except Exception as e:
        print(f"❌ 同步失败: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()

if __name__ == "__main__":
    sync_all_mcc()















