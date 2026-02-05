"""
测试服务账号配置

运行方式：
cd backend
python -m scripts.test_service_account

此脚本会：
1. 检查服务账号配置是否正确
2. 测试与 Google Ads API 的连接
3. 列出可访问的 MCC 账号
"""
import sys
import os
import json
import base64
from pathlib import Path

# 将 backend 目录添加到路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import settings


def check_service_account_config():
    """检查服务账号配置"""
    print("=" * 60)
    print("检查服务账号配置")
    print("=" * 60)
    
    credentials = None
    source = None
    
    # 检查开发者令牌
    if settings.google_ads_shared_developer_token:
        print(f"✅ 开发者令牌已配置: {settings.google_ads_shared_developer_token[:10]}...")
    else:
        print("❌ 开发者令牌未配置")
        print("   请在 .env 文件中设置 GOOGLE_ADS_SHARED_DEVELOPER_TOKEN")
        return None
    
    # 方式1：Base64编码的JSON
    if settings.google_ads_service_account_json_base64:
        try:
            json_content = base64.b64decode(settings.google_ads_service_account_json_base64).decode('utf-8')
            credentials = json.loads(json_content)
            source = "环境变量 (Base64)"
            print(f"✅ 服务账号配置加载成功（来源: {source}）")
        except Exception as e:
            print(f"❌ 解析服务账号Base64配置失败: {e}")
    
    # 方式2：JSON文件路径
    if not credentials and settings.google_ads_service_account_file:
        file_path = Path(settings.google_ads_service_account_file)
        if not file_path.is_absolute():
            file_path = Path(__file__).parent.parent / file_path
        
        if file_path.exists():
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    credentials = json.load(f)
                source = f"文件 ({file_path})"
                print(f"✅ 服务账号配置加载成功（来源: {source}）")
            except Exception as e:
                print(f"❌ 读取服务账号文件失败: {e}")
        else:
            print(f"⚠️  服务账号文件不存在: {file_path}")
    
    # 方式3：默认配置文件
    if not credentials:
        default_path = Path(__file__).parent.parent / "config" / "service_account.json"
        if default_path.exists():
            try:
                with open(default_path, 'r', encoding='utf-8') as f:
                    credentials = json.load(f)
                source = f"默认文件 ({default_path})"
                print(f"✅ 服务账号配置加载成功（来源: {source}）")
            except Exception as e:
                print(f"❌ 读取默认服务账号文件失败: {e}")
    
    if credentials:
        print(f"\n服务账号信息:")
        print(f"  - 类型: {credentials.get('type')}")
        print(f"  - 项目ID: {credentials.get('project_id')}")
        print(f"  - 邮箱: {credentials.get('client_email')}")
        return credentials
    else:
        print("\n❌ 未找到服务账号配置")
        print("请通过以下方式之一配置服务账号:")
        print("  1. 设置环境变量 GOOGLE_ADS_SERVICE_ACCOUNT_JSON_BASE64")
        print("  2. 设置环境变量 GOOGLE_ADS_SERVICE_ACCOUNT_FILE 指向JSON文件")
        print("  3. 将 JSON 文件放到 backend/config/service_account.json")
        return None


def test_google_ads_connection(credentials):
    """测试 Google Ads API 连接"""
    print("\n" + "=" * 60)
    print("测试 Google Ads API 连接")
    print("=" * 60)
    
    try:
        from google.ads.googleads.client import GoogleAdsClient
        from google.oauth2 import service_account
    except ImportError:
        print("❌ Google Ads API 库未安装")
        print("   请执行: pip install google-ads")
        return False
    
    try:
        # 创建凭证
        creds = service_account.Credentials.from_service_account_info(
            credentials,
            scopes=["https://www.googleapis.com/auth/adwords"]
        )
        
        # 创建客户端
        client = GoogleAdsClient(credentials=creds, developer_token=settings.google_ads_shared_developer_token)
        
        print("✅ 成功创建 Google Ads 客户端")
        
        # 获取可访问的客户账号
        customer_service = client.get_service("CustomerService")
        accessible_customers = customer_service.list_accessible_customers()
        
        print(f"\n可访问的客户账号 (共 {len(accessible_customers.resource_names)} 个):")
        for resource_name in accessible_customers.resource_names[:10]:  # 只显示前10个
            customer_id = resource_name.split("/")[-1]
            print(f"  - {customer_id}")
        
        if len(accessible_customers.resource_names) > 10:
            print(f"  ... 还有 {len(accessible_customers.resource_names) - 10} 个")
        
        return True
        
    except Exception as e:
        print(f"❌ 连接失败: {e}")
        
        # 分析错误类型
        error_str = str(e)
        if "DEVELOPER_TOKEN_PROHIBITED" in error_str:
            print("\n可能的原因:")
            print("  1. 开发者令牌未激活（新令牌需要 Google 审核）")
            print("  2. 开发者令牌与 GCP 项目不匹配")
        elif "PERMISSION_DENIED" in error_str:
            print("\n可能的原因:")
            print("  1. 服务账号未添加到 MCC 用户列表")
            print("  2. 服务账号权限不足")
        elif "quota" in error_str.lower():
            print("\n可能的原因:")
            print("  API 配额已用完，请稍后重试")
        
        return False


def main():
    print("\n" + "🔍 Google Ads 服务账号配置测试工具" + "\n")
    
    # 检查配置
    credentials = check_service_account_config()
    
    if not credentials:
        print("\n⚠️  请先配置服务账号，然后重新运行此脚本")
        return
    
    # 测试连接
    success = test_google_ads_connection(credentials)
    
    print("\n" + "=" * 60)
    if success:
        print("✅ 所有测试通过！服务账号配置正确")
        print("\n下一步:")
        print("  1. 确保服务账号已添加到所有 MCC 的用户列表")
        print("  2. 在系统中添加 MCC 账号")
        print("  3. 运行数据同步")
    else:
        print("❌ 测试未通过，请检查上述错误信息")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    main()

