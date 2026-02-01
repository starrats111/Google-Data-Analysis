"""
检查账号API配置的脚本
用于诊断API URL配置问题
"""
import sys
import os
import json

# 添加项目根目录到路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal
from app.models.affiliate_account import AffiliateAccount
from app.services.api_config_service import ApiConfigService

def check_account_config(account_id: int = None):
    """检查账号配置"""
    db = SessionLocal()
    try:
        if account_id:
            accounts = db.query(AffiliateAccount).filter(AffiliateAccount.id == account_id).all()
        else:
            accounts = db.query(AffiliateAccount).all()
        
        if not accounts:
            print("❌ 未找到账号")
            return
        
        for account in accounts:
            print(f"\n{'='*60}")
            print(f"账号ID: {account.id}")
            print(f"账号名称: {account.account_name}")
            print(f"平台: {account.platform.platform_name if account.platform else '未设置'} ({account.platform.platform_code if account.platform else 'N/A'})")
            print(f"{'='*60}")
            
            # 显示原始备注
            print(f"\n📝 原始备注内容:")
            if account.notes:
                print(f"  {account.notes}")
                try:
                    notes_data = json.loads(account.notes)
                    print(f"  ✅ JSON格式正确")
                    print(f"  📋 解析后的内容:")
                    for key, value in notes_data.items():
                        if 'token' in key.lower():
                            print(f"    {key}: {'*' * min(len(str(value)), 20)}")
                        else:
                            print(f"    {key}: {value}")
                except json.JSONDecodeError as e:
                    print(f"  ❌ JSON格式错误: {e}")
            else:
                print("  ⚠️  备注为空")
            
            # 获取API配置
            print(f"\n🔧 API配置:")
            api_config = ApiConfigService.get_account_api_config(account)
            print(f"  完整配置: {api_config}")
            base_url = api_config.get("base_url")
            if base_url:
                print(f"  ✅ base_url: {base_url}")
                transaction_endpoint = api_config.get("transaction_details_endpoint", "/transaction_details")
                full_url = f"{base_url}{transaction_endpoint}"
                print(f"  📍 完整API端点: {full_url}")
            else:
                print(f"  ❌ base_url: 未配置")
                default_config = ApiConfigService.get_platform_config(account.platform.platform_code if account.platform else None)
                default_base_url = default_config.get("base_url")
                if default_base_url:
                    print(f"  📌 默认base_url: {default_base_url}")
                else:
                    print(f"  ⚠️  默认base_url也不存在")
            
            print(f"\n💡 建议:")
            platform_code = (account.platform.platform_code or "").lower() if account.platform else ""
            if platform_code in ["rewardoo", "rw"]:
                if not base_url:
                    print(f"  请在账号备注中添加:")
                    print(f'    {{"rewardoo_api_url": "https://www.rewardoo.com/parcelandplate/creator/api"}}')
                    print(f"  或者:")
                    print(f'    {{"rw_api_url": "https://api.rewardoo.com/api"}}')
                else:
                    print(f"  当前配置的URL: {base_url}")
                    print(f"  如果仍然404，请检查URL是否正确")
                    print(f"  可以尝试:")
                    print(f"    1. 联系Rewardoo技术支持确认正确的API端点")
                    print(f"    2. 使用'测试连接'功能自动检测端点")
    
    finally:
        db.close()

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="检查账号API配置")
    parser.add_argument("--account-id", type=int, help="账号ID（可选，不指定则检查所有账号）")
    args = parser.parse_args()
    
    check_account_config(args.account_id)

