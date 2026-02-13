#!/usr/bin/env python3
"""
07的新令牌测试脚本 - 测试新令牌是否可用
"""
import sys
import os
from pathlib import Path

backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

from app.config import settings
from app.database import SessionLocal
from app.models.google_ads_api_data import GoogleMccAccount

def test_token():
    """测试新令牌"""
    print("=== 测试新令牌 ===")
    print("")
    
    # 1. 检查当前配置的令牌
    current_token = settings.google_ads_shared_developer_token
    new_token = "hWBTxgYlOiWB4XfXQl_UfA"
    
    print(f"当前配置的令牌: {current_token[:10]}... (长度: {len(current_token)})")
    print(f"要测试的新令牌: {new_token[:10]}... (长度: {len(new_token)})")
    print("")
    
    if current_token == new_token:
        print("✅ 新令牌已经配置在系统中")
    else:
        print("⚠️  新令牌还未配置，当前使用的是旧令牌")
        print("")
        print("是否要更新为新令牌？(y/n): ", end="")
        # 自动更新
        update = "y"
        if update.lower() == "y":
            print("正在更新...")
            # 更新.env文件
            env_file = backend_dir / ".env"
            if env_file.exists():
                with open(env_file, 'r', encoding='utf-8') as f:
                    lines = f.readlines()
                
                updated = False
                new_lines = []
                for line in lines:
                    if line.strip().startswith('GOOGLE_ADS_SHARED_DEVELOPER_TOKEN'):
                        new_lines.append(f"GOOGLE_ADS_SHARED_DEVELOPER_TOKEN={new_token}\n")
                        updated = True
                    else:
                        new_lines.append(line)
                
                if not updated:
                    if new_lines and not new_lines[-1].endswith('\n'):
                        new_lines.append('\n')
                    new_lines.append(f"GOOGLE_ADS_SHARED_DEVELOPER_TOKEN={new_token}\n")
                
                with open(env_file, 'w', encoding='utf-8') as f:
                    f.writelines(new_lines)
                
                print("✅ 令牌已更新")
            else:
                print("❌ 找不到.env文件")
    
    print("")
    print("=== 测试令牌权限 ===")
    print("")
    
    # 2. 测试令牌是否能访问API
    try:
        from google.ads.googleads.client import GoogleAdsClient
        from google.ads.googleads.errors import GoogleAdsException
    except ImportError:
        print("❌ Google Ads API库未安装")
        return
    
    # 获取一个MCC账号进行测试
    db = SessionLocal()
    mcc_account = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.is_active == True
    ).first()
    
    if not mcc_account:
        print("❌ 没有找到激活的MCC账号")
        db.close()
        return
    
    print(f"使用MCC账号进行测试: {mcc_account.mcc_name} ({mcc_account.mcc_id})")
    print("")
    
    # 重新加载配置（因为可能刚更新了.env）
    from app.config import settings
    settings = settings.__class__()
    test_token = settings.google_ads_shared_developer_token
    
    if not test_token:
        print("❌ 令牌配置为空")
        db.close()
        return
    
    # 测试创建客户端
    try:
        mcc_customer_id = mcc_account.mcc_id.replace("-", "").strip()
        
        if not mcc_customer_id.isdigit() or len(mcc_customer_id) != 10:
            print(f"❌ MCC ID格式错误: {mcc_account.mcc_id}")
            db.close()
            return
        
        print("步骤1: 创建Google Ads客户端...")
        client = GoogleAdsClient.load_from_dict({
            "developer_token": test_token,
            "client_id": mcc_account.client_id,
            "client_secret": mcc_account.client_secret,
            "refresh_token": mcc_account.refresh_token,
            "login_customer_id": mcc_customer_id,
            "use_proto_plus": True
        })
        print("✅ 客户端创建成功")
        print("")
        
        print("步骤2: 测试API调用（获取客户列表）...")
        try:
            customer_service = client.get_service("CustomerService")
            accessible_customers = customer_service.list_accessible_customers()
            print(f"✅ API调用成功！找到 {len(accessible_customers.resource_names)} 个可访问的客户")
            print("")
            print("✅✅✅ 新令牌可以使用！权限正常！")
        except GoogleAdsException as ex:
            error_code = ex.error.code().name if hasattr(ex.error, 'code') else "UNKNOWN"
            error_message = ex.error.message if hasattr(ex.error, 'message') else str(ex)
            
            if "DEVELOPER_TOKEN_PROHIBITED" in error_code or "Developer token is not allowed" in error_message:
                print("❌ 令牌被禁止使用")
                print(f"   错误代码: {error_code}")
                print(f"   错误信息: {error_message}")
                print("")
                print("可能的原因:")
                print("1. 新令牌需要等待Google审核（通常1-3个工作日）")
                print("2. 令牌需要与正确的Google Cloud项目关联")
                print("3. 令牌权限不足")
            elif "PERMISSION_DENIED" in error_code:
                print("❌ 权限被拒绝")
                print(f"   错误代码: {error_code}")
                print(f"   错误信息: {error_message}")
            else:
                print(f"❌ API调用失败")
                print(f"   错误代码: {error_code}")
                print(f"   错误信息: {error_message}")
        except Exception as e:
            print(f"❌ 测试失败: {e}")
            import traceback
            traceback.print_exc()
    
    except Exception as e:
        print(f"❌ 创建客户端失败: {e}")
        import traceback
        traceback.print_exc()
    
    db.close()
    print("")
    print("=== 测试完成 ===")

if __name__ == "__main__":
    test_token()


"""
07的新令牌测试脚本 - 测试新令牌是否可用
"""
import sys
import os
from pathlib import Path

backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

from app.config import settings
from app.database import SessionLocal
from app.models.google_ads_api_data import GoogleMccAccount

def test_token():
    """测试新令牌"""
    print("=== 测试新令牌 ===")
    print("")
    
    # 1. 检查当前配置的令牌
    current_token = settings.google_ads_shared_developer_token
    new_token = "hWBTxgYlOiWB4XfXQl_UfA"
    
    print(f"当前配置的令牌: {current_token[:10]}... (长度: {len(current_token)})")
    print(f"要测试的新令牌: {new_token[:10]}... (长度: {len(new_token)})")
    print("")
    
    if current_token == new_token:
        print("✅ 新令牌已经配置在系统中")
    else:
        print("⚠️  新令牌还未配置，当前使用的是旧令牌")
        print("")
        print("是否要更新为新令牌？(y/n): ", end="")
        # 自动更新
        update = "y"
        if update.lower() == "y":
            print("正在更新...")
            # 更新.env文件
            env_file = backend_dir / ".env"
            if env_file.exists():
                with open(env_file, 'r', encoding='utf-8') as f:
                    lines = f.readlines()
                
                updated = False
                new_lines = []
                for line in lines:
                    if line.strip().startswith('GOOGLE_ADS_SHARED_DEVELOPER_TOKEN'):
                        new_lines.append(f"GOOGLE_ADS_SHARED_DEVELOPER_TOKEN={new_token}\n")
                        updated = True
                    else:
                        new_lines.append(line)
                
                if not updated:
                    if new_lines and not new_lines[-1].endswith('\n'):
                        new_lines.append('\n')
                    new_lines.append(f"GOOGLE_ADS_SHARED_DEVELOPER_TOKEN={new_token}\n")
                
                with open(env_file, 'w', encoding='utf-8') as f:
                    f.writelines(new_lines)
                
                print("✅ 令牌已更新")
            else:
                print("❌ 找不到.env文件")
    
    print("")
    print("=== 测试令牌权限 ===")
    print("")
    
    # 2. 测试令牌是否能访问API
    try:
        from google.ads.googleads.client import GoogleAdsClient
        from google.ads.googleads.errors import GoogleAdsException
    except ImportError:
        print("❌ Google Ads API库未安装")
        return
    
    # 获取一个MCC账号进行测试
    db = SessionLocal()
    mcc_account = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.is_active == True
    ).first()
    
    if not mcc_account:
        print("❌ 没有找到激活的MCC账号")
        db.close()
        return
    
    print(f"使用MCC账号进行测试: {mcc_account.mcc_name} ({mcc_account.mcc_id})")
    print("")
    
    # 重新加载配置（因为可能刚更新了.env）
    from app.config import settings
    settings = settings.__class__()
    test_token = settings.google_ads_shared_developer_token
    
    if not test_token:
        print("❌ 令牌配置为空")
        db.close()
        return
    
    # 测试创建客户端
    try:
        mcc_customer_id = mcc_account.mcc_id.replace("-", "").strip()
        
        if not mcc_customer_id.isdigit() or len(mcc_customer_id) != 10:
            print(f"❌ MCC ID格式错误: {mcc_account.mcc_id}")
            db.close()
            return
        
        print("步骤1: 创建Google Ads客户端...")
        client = GoogleAdsClient.load_from_dict({
            "developer_token": test_token,
            "client_id": mcc_account.client_id,
            "client_secret": mcc_account.client_secret,
            "refresh_token": mcc_account.refresh_token,
            "login_customer_id": mcc_customer_id,
            "use_proto_plus": True
        })
        print("✅ 客户端创建成功")
        print("")
        
        print("步骤2: 测试API调用（获取客户列表）...")
        try:
            customer_service = client.get_service("CustomerService")
            accessible_customers = customer_service.list_accessible_customers()
            print(f"✅ API调用成功！找到 {len(accessible_customers.resource_names)} 个可访问的客户")
            print("")
            print("✅✅✅ 新令牌可以使用！权限正常！")
        except GoogleAdsException as ex:
            error_code = ex.error.code().name if hasattr(ex.error, 'code') else "UNKNOWN"
            error_message = ex.error.message if hasattr(ex.error, 'message') else str(ex)
            
            if "DEVELOPER_TOKEN_PROHIBITED" in error_code or "Developer token is not allowed" in error_message:
                print("❌ 令牌被禁止使用")
                print(f"   错误代码: {error_code}")
                print(f"   错误信息: {error_message}")
                print("")
                print("可能的原因:")
                print("1. 新令牌需要等待Google审核（通常1-3个工作日）")
                print("2. 令牌需要与正确的Google Cloud项目关联")
                print("3. 令牌权限不足")
            elif "PERMISSION_DENIED" in error_code:
                print("❌ 权限被拒绝")
                print(f"   错误代码: {error_code}")
                print(f"   错误信息: {error_message}")
            else:
                print(f"❌ API调用失败")
                print(f"   错误代码: {error_code}")
                print(f"   错误信息: {error_message}")
        except Exception as e:
            print(f"❌ 测试失败: {e}")
            import traceback
            traceback.print_exc()
    
    except Exception as e:
        print(f"❌ 创建客户端失败: {e}")
        import traceback
        traceback.print_exc()
    
    db.close()
    print("")
    print("=== 测试完成 ===")

if __name__ == "__main__":
    test_token()














