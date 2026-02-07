"""
从 Google Ads API 获取 MCC 账号的真实货币代码并更新数据库

这个脚本会：
1. 遍历所有 MCC 账号
2. 通过 Google Ads API 查询每个 MCC 下的子账号
3. 获取子账号的 currency_code（货币代码）
4. 如果有 CNY 账号，将 MCC 标记为 CNY；否则使用主流货币

使用方法：
  python sync_mcc_currency_from_api.py         # 交互模式，需要确认
  python sync_mcc_currency_from_api.py --fix   # 直接修复，无需确认
"""
import sys
import os
sys.path.insert(0, '.')

from collections import Counter
from app.database import SessionLocal
from app.models.google_ads_api_data import GoogleMccAccount
from app.config import settings

db = SessionLocal()

# 是否直接修复（无需确认）
auto_fix = '--fix' in sys.argv

print("=" * 70)
print("从 Google Ads API 同步 MCC 货币代码")
print("=" * 70)

# 检查 Developer Token
if not settings.google_ads_shared_developer_token:
    print("\n❌ 错误：未配置 GOOGLE_ADS_SHARED_DEVELOPER_TOKEN")
    print("请在 .env 文件中配置 Developer Token")
    sys.exit(1)

# 检查服务账号配置
service_account_path = settings.google_ads_service_account_file
if not service_account_path:
    # 尝试 Base64 配置
    if settings.google_ads_service_account_json_base64:
        print(f"\n✅ Developer Token: 已配置")
        print(f"✅ 服务账号: Base64 配置")
        service_account_path = None  # 使用 Base64
    else:
        print(f"\n❌ 错误：未配置服务账号")
        print("请配置 GOOGLE_ADS_SERVICE_ACCOUNT_FILE 或 GOOGLE_ADS_SERVICE_ACCOUNT_JSON_BASE64")
        sys.exit(1)
elif not os.path.exists(service_account_path):
    print(f"\n❌ 错误：服务账号配置文件不存在: {service_account_path}")
    print("请确保 GOOGLE_ADS_SERVICE_ACCOUNT_FILE 配置正确")
    sys.exit(1)
else:
    print(f"\n✅ Developer Token: 已配置")
    print(f"✅ 服务账号: {service_account_path}")

# 准备 Google Ads 客户端配置
try:
    from google.ads.googleads.client import GoogleAdsClient
    from google.ads.googleads.errors import GoogleAdsException
    import base64
    import json
    import tempfile
    
    # 确定服务账号路径
    json_key_path = service_account_path
    temp_file_path = None
    
    if not json_key_path and settings.google_ads_service_account_json_base64:
        # 从 Base64 解码并写入临时文件
        json_content = base64.b64decode(settings.google_ads_service_account_json_base64).decode('utf-8')
        temp_file = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
        temp_file.write(json_content)
        temp_file.close()
        json_key_path = temp_file.name
        temp_file_path = temp_file.name
    
    print("✅ Google Ads 客户端配置准备完成")
    
    def create_client_for_mcc(mcc_customer_id: str) -> GoogleAdsClient:
        """为特定 MCC 创建客户端"""
        config = {
            "developer_token": settings.google_ads_shared_developer_token,
            "use_proto_plus": True,
            "json_key_file_path": json_key_path,
            "login_customer_id": mcc_customer_id,  # 设置 MCC 作为登录客户
        }
        return GoogleAdsClient.load_from_dict(config)
        
except Exception as e:
    print(f"\n❌ 初始化 Google Ads 客户端失败: {e}")
    sys.exit(1)

# 获取所有 MCC 账号
mcc_accounts = db.query(GoogleMccAccount).filter(GoogleMccAccount.is_active == True).all()
print(f"\n共找到 {len(mcc_accounts)} 个活跃 MCC 账号\n")

needs_update = []
already_correct = []
errors = []

for mcc in mcc_accounts:
    mcc_customer_id = mcc.mcc_id.replace("-", "")
    current_currency = mcc.currency or 'USD'
    
    print(f"🔍 检查 MCC: {mcc.mcc_name} (ID: {mcc_customer_id})")
    
    try:
        # 为该 MCC 创建客户端
        google_client = create_client_for_mcc(mcc_customer_id)
        
        # 查询子账号的货币代码
        query = """
            SELECT
                customer_client.id,
                customer_client.descriptive_name,
                customer_client.currency_code
            FROM customer_client
            WHERE customer_client.manager = FALSE
            AND customer_client.status = 'ENABLED'
        """
        
        ga_service = google_client.get_service("GoogleAdsService")
        response = ga_service.search(customer_id=mcc_customer_id, query=query)
        
        # 收集所有子账号的货币代码
        currency_codes = []
        for row in response:
            currency_code = row.customer_client.currency_code or "USD"
            currency_codes.append(currency_code)
            # print(f"    子账号 {row.customer_client.id}: {currency_code}")
        
        if not currency_codes:
            print(f"    ⚠️ 未找到子账号")
            continue
        
        # 统计货币代码
        currency_counter = Counter(currency_codes)
        print(f"    货币统计: {dict(currency_counter)}")
        
        # 确定 MCC 的货币：如果有 CNY，则标记为 CNY；否则使用最多的货币
        if "CNY" in currency_counter:
            detected_currency = "CNY"
        else:
            detected_currency = currency_counter.most_common(1)[0][0]
        
        print(f"    当前货币: {current_currency}, 检测货币: {detected_currency}")
        
        if current_currency != detected_currency:
            needs_update.append((mcc, detected_currency, dict(currency_counter)))
            print(f"    ⚠️ 需要更新: {current_currency} → {detected_currency}")
        else:
            already_correct.append(mcc)
            print(f"    ✅ 货币正确")
        
    except GoogleAdsException as ex:
        error_msg = f"API错误: {ex.error.code().name}"
        errors.append((mcc, error_msg))
        print(f"    ❌ {error_msg}")
    except Exception as e:
        error_msg = str(e)
        errors.append((mcc, error_msg))
        print(f"    ❌ 错误: {error_msg}")
    
    print()

print("=" * 70)
print(f"检查完成：{len(already_correct)} 个正确，{len(needs_update)} 个需要更新，{len(errors)} 个错误")
print("=" * 70)

if errors:
    print("\n❌ 出错的账号：")
    for mcc, error_msg in errors:
        print(f"  - {mcc.mcc_name}: {error_msg}")

if needs_update:
    print("\n需要更新的账号：")
    for mcc, new_currency, currency_stats in needs_update:
        print(f"  - {mcc.mcc_name}: {mcc.currency or 'NULL'} → {new_currency} (统计: {currency_stats})")
    
    if auto_fix:
        confirm = 'y'
        print("\n[自动修复模式] 正在执行更新...")
    else:
        confirm = input("\n是否执行更新？(y/n): ").strip().lower()
    
    if confirm == 'y':
        for mcc, new_currency, _ in needs_update:
            old_currency = mcc.currency
            mcc.currency = new_currency
            print(f"  ✅ 已更新 {mcc.mcc_name}: {old_currency} → {new_currency}")
        
        db.commit()
        print("\n✅ 所有更新已保存！")
        print("后端会自动将 CNY 费用转换为 USD 显示（汇率 7.2）")
    else:
        print("\n❌ 已取消更新")
else:
    print("\n✅ 所有 MCC 账号的货币设置都正确！")

db.close()

