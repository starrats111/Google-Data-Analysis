"""
检查 LinkHaiTao API 返回的原始数据格式
查看 merchant_id / m_id / mcid 等字段的实际值
"""
import sys
sys.path.insert(0, '/home/admin/Google-Data-Analysis/backend')

import requests
import json
from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform

db = SessionLocal()

# 获取 wj03 的 LH 账号
wj03 = db.query(User).filter(User.username == "wj03").first()
if not wj03:
    print("错误: 找不到 wj03 用户")
    sys.exit(1)

lh_platform = db.query(AffiliatePlatform).filter(AffiliatePlatform.platform_code == "lh").first()
if not lh_platform:
    print("错误: 找不到 LH 平台")
    sys.exit(1)

lh_account = db.query(AffiliateAccount).filter(
    AffiliateAccount.user_id == wj03.id,
    AffiliateAccount.platform_id == lh_platform.id
).first()

if not lh_account:
    print("错误: 找不到 wj03 的 LH 账号")
    sys.exit(1)

print(f"找到 wj03 的 LH 账号: {lh_account.account_name} (ID: {lh_account.id})")

# 从备注中获取 token
token = None
if lh_account.notes:
    try:
        notes_data = json.loads(lh_account.notes)
        token = notes_data.get("linkhaitao_token") or notes_data.get("api_token") or notes_data.get("token")
    except:
        pass

if not token:
    print("错误: 未找到 LinkHaiTao Token")
    sys.exit(1)

print(f"Token: {token[:10]}...")

# 调用 LH API 获取原始数据
base_url = "https://www.linkhaitao.com"
api_url = f"{base_url}/api.php?mod=medium&op=cashback2"

params = {
    "token": token,
    "begin_date": "2026-02-01",
    "end_date": "2026-02-12",
    "page": 1,
    "per_page": 10,  # 只获取10条来检查格式
    "status": "all"
}

print(f"\n调用 LH API: {api_url}")
print(f"参数: {params}")

try:
    response = requests.post(api_url, data=params, timeout=30)
    response.raise_for_status()
    data = response.json()
    
    print(f"\nAPI 响应状态: {data.get('status', {})}")
    
    # 获取订单数据
    orders_data = data.get("data", [])
    if isinstance(orders_data, dict):
        orders = orders_data.get("list", [])
        total = orders_data.get("total", 0)
        print(f"总订单数: {total}")
    else:
        orders = orders_data
    
    print(f"返回订单数: {len(orders)}")
    
    # 检查第一个订单的字段
    if orders:
        print("\n" + "=" * 70)
        print("前3个订单的完整字段:")
        print("=" * 70)
        for i, order in enumerate(orders[:3]):
            print(f"\n--- 订单 {i+1} ---")
            if isinstance(order, str):
                try:
                    order = json.loads(order)
                except:
                    print(f"  (字符串格式): {order[:200]}")
                    continue
            
            for key, value in order.items():
                print(f"  {key}: {value}")
        
        # 特别关注 merchant_id 相关字段
        print("\n" + "=" * 70)
        print("关键字段检查 (所有订单):")
        print("=" * 70)
        
        for i, order in enumerate(orders[:5]):
            if isinstance(order, str):
                try:
                    order = json.loads(order)
                except:
                    continue
            
            print(f"\n订单 {i+1}:")
            print(f"  m_id: {order.get('m_id')}")
            print(f"  mcid: {order.get('mcid')}")
            print(f"  brand_id: {order.get('brand_id')}")
            print(f"  merchant_id: {order.get('merchant_id')}")
            print(f"  advertiser_id: {order.get('advertiser_id')}")
            print(f"  advertiser_name: {order.get('advertiser_name')}")
            print(f"  cashback: {order.get('cashback')}")
            print(f"  order_id: {order.get('order_id')}")

except Exception as e:
    print(f"API 调用失败: {e}")

db.close()

