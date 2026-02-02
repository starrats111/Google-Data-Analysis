"""
检查所有员工的MCC账号配置
确保所有账号都能正常同步
"""
import sys
import os

# 添加项目根目录到路径
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.database import SessionLocal
from app.models.google_ads_api_data import GoogleMccAccount
from app.models.user import User
from app.config import settings

def check_all_mcc_accounts():
    """检查所有员工的MCC账号配置"""
    db = SessionLocal()
    try:
        # 获取所有员工
        employees = db.query(User).filter(User.role == "employee").all()
        
        print(f"找到 {len(employees)} 个员工账号\n")
        print("=" * 80)
        
        all_ok = True
        issues = []
        
        for employee in employees:
            print(f"\n员工: {employee.username} (ID: {employee.id})")
            print("-" * 80)
            
            # 获取该员工的所有MCC账号
            mcc_accounts = db.query(GoogleMccAccount).filter(
                GoogleMccAccount.user_id == employee.id
            ).all()
            
            if not mcc_accounts:
                print("  ⚠️  该员工没有MCC账号")
                issues.append(f"{employee.username}: 没有MCC账号")
                all_ok = False
                continue
            
            print(f"  MCC账号数量: {len(mcc_accounts)}")
            
            for mcc in mcc_accounts:
                print(f"\n  MCC账号ID: {mcc.id}")
                print(f"    MCC ID: {mcc.mcc_id}")
                print(f"    MCC名称: {mcc.mcc_name}")
                print(f"    邮箱: {mcc.email}")
                print(f"    状态: {'✅ 激活' if mcc.is_active else '❌ 停用'}")
                
                # 检查配置
                config_ok = True
                missing_configs = []
                
                if not mcc.client_id:
                    missing_configs.append("client_id")
                    config_ok = False
                if not mcc.client_secret:
                    missing_configs.append("client_secret")
                    config_ok = False
                if not mcc.refresh_token:
                    missing_configs.append("refresh_token")
                    config_ok = False
                
                if config_ok:
                    print(f"    API配置: ✅ 完整")
                else:
                    print(f"    API配置: ❌ 缺少: {', '.join(missing_configs)}")
                    issues.append(f"{employee.username} - {mcc.mcc_name} (ID:{mcc.id}): 缺少API配置 ({', '.join(missing_configs)})")
                    all_ok = False
                
                # 检查MCC ID格式
                mcc_customer_id = mcc.mcc_id.replace("-", "").strip()
                if mcc_customer_id.isdigit() and len(mcc_customer_id) == 10:
                    print(f"    MCC ID格式: ✅ 正确 ({len(mcc_customer_id)}位数字)")
                else:
                    print(f"    MCC ID格式: ❌ 错误 (去掉横线后: {mcc_customer_id}, {len(mcc_customer_id)}位)")
                    issues.append(f"{employee.username} - {mcc.mcc_name} (ID:{mcc.id}): MCC ID格式错误 ({mcc.mcc_id})")
                    all_ok = False
        
        print("\n" + "=" * 80)
        print("\n系统配置检查:")
        print("-" * 80)
        
        if settings.google_ads_shared_developer_token:
            print("  Developer Token: ✅ 已配置")
        else:
            print("  Developer Token: ❌ 未配置")
            issues.append("系统: 缺少GOOGLE_ADS_SHARED_DEVELOPER_TOKEN配置")
            all_ok = False
        
        print("\n" + "=" * 80)
        print("\n总结:")
        print("-" * 80)
        
        if all_ok:
            print("✅ 所有MCC账号配置完整，可以正常同步！")
        else:
            print("❌ 发现以下问题需要修复：\n")
            for i, issue in enumerate(issues, 1):
                print(f"  {i}. {issue}")
            print("\n请修复上述问题后重新检查。")
        
        return all_ok
        
    except Exception as e:
        print(f"❌ 检查过程中出现错误: {e}")
        import traceback
        traceback.print_exc()
        return False
    finally:
        db.close()

if __name__ == "__main__":
    check_all_mcc_accounts()

