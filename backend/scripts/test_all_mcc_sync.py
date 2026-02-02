"""
测试所有员工的MCC账号同步功能
确保所有账号都能正常同步数据
"""
import sys
import os
from datetime import date, timedelta

# 添加项目根目录到路径
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.database import SessionLocal
from app.models.google_ads_api_data import GoogleMccAccount
from app.models.user import User
from app.services.google_ads_api_sync import GoogleAdsApiSyncService

def test_all_mcc_sync():
    """测试所有员工的MCC账号同步功能"""
    db = SessionLocal()
    try:
        # 获取所有员工
        employees = db.query(User).filter(User.role == "employee").order_by(User.id).all()
        
        print(f"找到 {len(employees)} 个员工账号\n")
        print("=" * 80)
        
        # 测试日期：昨天（因为今天的数据可能不完整）
        test_date = date.today() - timedelta(days=1)
        print(f"测试日期: {test_date.isoformat()}\n")
        
        sync_service = GoogleAdsApiSyncService(db)
        
        all_results = []
        
        for employee in employees:
            print(f"\n员工: {employee.username} (ID: {employee.id})")
            print("-" * 80)
            
            # 获取该员工的所有激活的MCC账号
            mcc_accounts = db.query(GoogleMccAccount).filter(
                GoogleMccAccount.user_id == employee.id,
                GoogleMccAccount.is_active == True
            ).all()
            
            if not mcc_accounts:
                print("  ⚠️  该员工没有激活的MCC账号")
                all_results.append({
                    "employee": employee.username,
                    "mcc_count": 0,
                    "status": "no_mcc"
                })
                continue
            
            print(f"  MCC账号数量: {len(mcc_accounts)}")
            
            employee_success = 0
            employee_failed = 0
            
            for mcc in mcc_accounts:
                print(f"\n  测试MCC账号: {mcc.mcc_name} (ID: {mcc.id})")
                
                # 检查配置
                if not mcc.client_id or not mcc.client_secret or not mcc.refresh_token:
                    print(f"    ❌ 跳过：缺少API配置")
                    employee_failed += 1
                    all_results.append({
                        "employee": employee.username,
                        "mcc_id": mcc.id,
                        "mcc_name": mcc.mcc_name,
                        "status": "missing_config"
                    })
                    continue
                
                # 检查MCC ID格式
                mcc_customer_id = mcc.mcc_id.replace("-", "").strip()
                if not mcc_customer_id.isdigit() or len(mcc_customer_id) != 10:
                    print(f"    ❌ 跳过：MCC ID格式错误 ({mcc.mcc_id})")
                    employee_failed += 1
                    all_results.append({
                        "employee": employee.username,
                        "mcc_id": mcc.id,
                        "mcc_name": mcc.mcc_name,
                        "status": "invalid_mcc_id"
                    })
                    continue
                
                # 尝试同步
                try:
                    print(f"    正在同步...")
                    result = sync_service.sync_mcc_data(mcc.id, test_date)
                    
                    if result.get("success"):
                        saved_count = result.get("saved_count", 0)
                        print(f"    ✅ 同步成功：保存了 {saved_count} 条记录")
                        employee_success += 1
                        all_results.append({
                            "employee": employee.username,
                            "mcc_id": mcc.id,
                            "mcc_name": mcc.mcc_name,
                            "status": "success",
                            "saved_count": saved_count
                        })
                    else:
                        error_msg = result.get("message", "未知错误")
                        print(f"    ❌ 同步失败：{error_msg}")
                        employee_failed += 1
                        all_results.append({
                            "employee": employee.username,
                            "mcc_id": mcc.id,
                            "mcc_name": mcc.mcc_name,
                            "status": "sync_failed",
                            "error": error_msg
                        })
                except Exception as e:
                    print(f"    ❌ 同步异常：{str(e)}")
                    employee_failed += 1
                    all_results.append({
                        "employee": employee.username,
                        "mcc_id": mcc.id,
                        "mcc_name": mcc.mcc_name,
                        "status": "exception",
                        "error": str(e)
                    })
            
            print(f"\n  员工 {employee.username} 同步结果：成功 {employee_success}，失败 {employee_failed}")
        
        print("\n" + "=" * 80)
        print("\n总结:")
        print("-" * 80)
        
        total_success = sum(1 for r in all_results if r.get("status") == "success")
        total_failed = sum(1 for r in all_results if r.get("status") != "success" and r.get("status") != "no_mcc")
        total_no_mcc = sum(1 for r in all_results if r.get("status") == "no_mcc")
        
        print(f"总员工数: {len(employees)}")
        print(f"✅ 同步成功: {total_success} 个MCC账号")
        print(f"❌ 同步失败: {total_failed} 个MCC账号")
        print(f"⚠️  无MCC账号: {total_no_mcc} 个员工")
        
        if total_failed > 0:
            print("\n失败的MCC账号:")
            for r in all_results:
                if r.get("status") != "success" and r.get("status") != "no_mcc":
                    print(f"  - {r.get('employee')} - {r.get('mcc_name')} (ID:{r.get('mcc_id')}): {r.get('status')}")
                    if r.get("error"):
                        print(f"    错误: {r.get('error')}")
        
        return total_failed == 0
        
    except Exception as e:
        print(f"❌ 测试过程中出现错误: {e}")
        import traceback
        traceback.print_exc()
        return False
    finally:
        db.close()

if __name__ == "__main__":
    success = test_all_mcc_sync()
    exit(0 if success else 1)

