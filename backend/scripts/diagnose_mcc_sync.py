"""
MCC 同步诊断脚本：精确定位 MCC 连接失败的原因

用法：
    cd ~/Google-Data-Analysis/backend
    source venv/bin/activate
    python -m scripts.diagnose_mcc_sync
"""
import sys
import os
import json
import traceback

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))


def main():
    print("=" * 70)
    print("  MCC 同步诊断工具")
    print("=" * 70)

    # 1. 检查数据库中的 MCC 账号
    print("\n[1/6] 检查数据库中的 MCC 账号...")
    from app.database import SessionLocal
    from app.models.google_ads_api_data import GoogleMccAccount
    from app.config import settings

    db = SessionLocal()
    mccs = db.query(GoogleMccAccount).all()

    if not mccs:
        print("  ❌ 数据库中没有 MCC 账号")
        return

    for mcc in mccs:
        print(f"\n  MCC #{mcc.id}: {mcc.mcc_id} ({mcc.mcc_name or 'N/A'})")
        print(f"    活跃: {mcc.is_active}")
        print(f"    货币: {getattr(mcc, 'currency', 'N/A')}")
        print(f"    客户数: {getattr(mcc, 'total_customers', 'N/A')}")
        print(f"    同步状态: {getattr(mcc, 'sync_status', 'N/A')}")
        print(f"    同步消息: {getattr(mcc, 'sync_message', 'N/A')}")
        print(f"    最后同步: {getattr(mcc, 'last_sync_at', 'N/A')}")
        print(f"    最后同步日期: {getattr(mcc, 'last_sync_date', 'N/A')}")
        print(f"    使用服务账号: {getattr(mcc, 'use_service_account', 'N/A')}")
        has_sa_json = bool(mcc.service_account_json and len(mcc.service_account_json) > 10)
        print(f"    有服务账号JSON: {has_sa_json} (长度: {len(mcc.service_account_json) if mcc.service_account_json else 0})")
        has_oauth = bool(mcc.refresh_token)
        print(f"    有OAuth令牌: {has_oauth}")

    # 2. 检查开发者令牌
    print("\n[2/6] 检查开发者令牌...")
    dev_token = settings.GOOGLE_ADS_SHARED_DEVELOPER_TOKEN
    if dev_token:
        print(f"  ✅ 开发者令牌已配置 (前6位: {dev_token[:6]}...)")
    else:
        print("  ❌ 开发者令牌未配置 (GOOGLE_ADS_SHARED_DEVELOPER_TOKEN)")
        print("     这会导致所有 MCC 同步失败！")

    # 3. 检查全局服务账号
    print("\n[3/6] 检查全局服务账号配置...")
    from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync

    sync_service = GoogleAdsServiceAccountSync(db)
    global_sa = sync_service._load_global_service_account()

    if global_sa:
        print(f"  ✅ 全局服务账号已加载")
        print(f"    类型: {global_sa.get('type', 'N/A')}")
        print(f"    项目: {global_sa.get('project_id', 'N/A')}")
        print(f"    邮箱: {global_sa.get('client_email', 'N/A')}")
    else:
        print("  ❌ 全局服务账号未配置")
        print("     检查环境变量 GOOGLE_ADS_SERVICE_ACCOUNT_JSON_BASE64 或 GOOGLE_ADS_SERVICE_ACCOUNT_FILE")

    # 4. 逐个 MCC 测试连接
    print("\n[4/6] 逐个 MCC 测试连接...")

    for mcc in mccs:
        if not mcc.is_active:
            print(f"\n  MCC {mcc.mcc_id}: 已停用，跳过")
            continue

        print(f"\n  MCC {mcc.mcc_id} ({mcc.mcc_name}):")

        # 4a. 检查凭证
        try:
            creds = sync_service._get_service_account_credentials(mcc)
            if creds:
                print(f"    ✅ 凭证获取成功 (邮箱: {creds.get('client_email', 'N/A')})")
            else:
                print(f"    ❌ 凭证获取失败（无服务账号也无全局配置）")
                continue
        except Exception as e:
            print(f"    ❌ 凭证获取异常: {e}")
            continue

        # 4b. 创建客户端
        try:
            client, mcc_customer_id = sync_service._create_client(mcc)
            print(f"    ✅ 客户端创建成功 (MCC ID: {mcc_customer_id})")
        except Exception as e:
            print(f"    ❌ 客户端创建失败: {e}")
            traceback.print_exc()
            continue

        # 4c. 查询客户账号 - 方法1
        print(f"    测试方法1 (CustomerClient 查询)...")
        try:
            from google.ads.googleads.errors import GoogleAdsException

            query = """
                SELECT
                    customer_client.id,
                    customer_client.descriptive_name,
                    customer_client.manager,
                    customer_client.status,
                    customer_client.currency_code
                FROM customer_client
                WHERE customer_client.manager = FALSE
                AND customer_client.status = 'ENABLED'
            """
            ga_service = client.get_service("GoogleAdsService")
            response = ga_service.search(customer_id=mcc_customer_id, query=query)

            count = 0
            currencies = set()
            for row in response:
                cid = str(row.customer_client.id)
                if cid != mcc_customer_id:
                    count += 1
                    cc = row.customer_client.currency_code or "USD"
                    currencies.add(cc)
                    if count <= 3:
                        print(f"      客户 {cid}: {row.customer_client.descriptive_name} ({cc})")

            if count > 3:
                print(f"      ... 还有 {count - 3} 个客户")

            if count > 0:
                print(f"    ✅ 方法1成功: 找到 {count} 个客户账号，货币: {currencies}")
            else:
                print(f"    ⚠️ 方法1: API 返回空结果（0 个客户）")

        except GoogleAdsException as ex:
            print(f"    ❌ 方法1 GoogleAdsException:")
            for error in ex.failure.errors:
                print(f"       错误码: {error.error_code}")
                print(f"       消息: {error.message}")
            print(f"       请求ID: {ex.request_id}")
        except Exception as e:
            print(f"    ❌ 方法1异常: {type(e).__name__}: {e}")
            traceback.print_exc()

        # 4d. 查询客户账号 - 方法2
        print(f"    测试方法2 (CustomerService)...")
        try:
            customer_service = client.get_service("CustomerService")
            accessible = customer_service.list_accessible_customers()
            resource_names = list(accessible.resource_names)
            other_ids = [r.split("/")[-1] for r in resource_names if r.split("/")[-1] != mcc_customer_id]
            print(f"    ✅ 方法2成功: 可访问 {len(resource_names)} 个账号 ({len(other_ids)} 个非MCC)")
            for rid in other_ids[:5]:
                print(f"      账号ID: {rid}")
            if len(other_ids) > 5:
                print(f"      ... 还有 {len(other_ids) - 5} 个")
        except Exception as e:
            print(f"    ❌ 方法2异常: {type(e).__name__}: {e}")

    # 5. 检查最近的同步数据
    print("\n[5/6] 检查最近的同步数据...")
    from app.models.google_ads_api_data import GoogleAdsApiData
    from sqlalchemy import func

    for mcc in mccs:
        latest = db.query(
            func.max(GoogleAdsApiData.date).label('max_date'),
            func.min(GoogleAdsApiData.date).label('min_date'),
            func.count(GoogleAdsApiData.id).label('total')
        ).filter(GoogleAdsApiData.mcc_id == mcc.id).first()

        print(f"\n  MCC {mcc.mcc_id} ({getattr(mcc, 'currency', 'USD')}):")
        print(f"    总记录数: {latest.total or 0}")
        print(f"    数据范围: {latest.min_date or 'N/A'} ~ {latest.max_date or 'N/A'}")

        if latest.max_date:
            from datetime import date, timedelta
            days_gap = (date.today() - latest.max_date).days if hasattr(latest.max_date, 'year') else 'N/A'
            print(f"    距今天数: {days_gap} 天")
            if isinstance(days_gap, int) and days_gap > 3:
                print(f"    ⚠️ 数据已过期超过 3 天！")

    # 6. 建议
    print("\n[6/6] 诊断建议...")
    print("  如果方法1和方法2都失败:")
    print("    - 检查服务账号是否已添加到 MCC 的'访问权限'中")
    print("    - 检查服务账号是否被禁用")
    print("    - 检查 Developer Token 的 API 访问级别（需要 Standard 或 Basic）")
    print("    - 检查 Google Cloud 项目中 Google Ads API 是否已启用")
    print("  如果只是 CNY 账号失败:")
    print("    - CNY 账号可能在不同的 MCC 层级下")
    print("    - 检查该 MCC 的服务账号是否有管理该子账号的权限")

    print("\n" + "=" * 70)
    print("  诊断完成")
    print("=" * 70)

    db.close()


if __name__ == "__main__":
    main()
