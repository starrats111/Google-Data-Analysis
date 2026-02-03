"""
分析重复订单的佣金问题
检查为什么API返回的总佣金和系统存储的佣金不一致
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.services.linkhaitao_service import LinkHaitaoService
import sqlite3
from collections import defaultdict

# Token
TOKEN = sys.argv[1] if len(sys.argv) > 1 else "5LabOMCN8XgtNIpH"

print("=" * 60)
print("分析重复订单的佣金问题")
print("=" * 60)

# 1. 从API获取所有订单
print("\n1. 从API获取所有订单...")
service = LinkHaitaoService(token=TOKEN)
result = service.sync_commissions_and_orders("2026-01-01", "2026-01-31")
orders = result.get("data", {}).get("orders", [])
print(f"   API返回订单数: {len(orders)}")
print(f"   API返回总佣金: ${result.get('total_commission', 0):.2f}")

# 2. 按订单ID分组，检查重复订单的佣金
print("\n2. 按订单ID分组，检查重复订单...")
orders_by_id = defaultdict(list)
for order in orders:
    tx_id = order.get("order_id") or order.get("id") or order.get("transaction_id")
    if tx_id:
        orders_by_id[tx_id].append(order)

duplicate_orders = {tx_id: orders for tx_id, orders in orders_by_id.items() if len(orders) > 1}

print(f"   唯一订单ID数: {len(orders_by_id)}")
print(f"   有重复的订单ID数: {len(duplicate_orders)}")

# 3. 检查重复订单的佣金是否相同
print("\n3. 检查重复订单的佣金是否相同...")
duplicate_with_diff_commission = []
duplicate_with_same_commission = []

for tx_id, order_list in list(duplicate_orders.items())[:20]:  # 只检查前20个
    commissions = [order.get("commission") or 0 for order in order_list]
    amounts = [order.get("amount") or 0 for order in order_list]
    statuses = [order.get("status") for order in order_list]
    
    if len(set(commissions)) > 1:
        duplicate_with_diff_commission.append({
            "tx_id": tx_id,
            "count": len(order_list),
            "commissions": commissions,
            "amounts": amounts,
            "statuses": statuses
        })
    else:
        duplicate_with_same_commission.append(tx_id)

print(f"   佣金相同的重复订单: {len(duplicate_with_same_commission)}")
print(f"   佣金不同的重复订单: {len(duplicate_with_diff_commission)}")

if duplicate_with_diff_commission:
    print(f"\n   前5个佣金不同的重复订单:")
    for dup in duplicate_with_diff_commission[:5]:
        print(f"     订单ID: {dup['tx_id']}, 重复次数: {dup['count']}")
        print(f"       佣金: {dup['commissions']}")
        print(f"       订单金额: {dup['amounts']}")
        print(f"       状态: {dup['statuses']}")

# 4. 计算去重后的总佣金
print("\n4. 计算去重后的总佣金...")
unique_commissions = {}
for tx_id, order_list in orders_by_id.items():
    # 对于重复订单，取第一条的佣金（或取最大值？）
    commission = order_list[0].get("commission") or 0
    unique_commissions[tx_id] = commission

unique_total_commission = sum(unique_commissions.values())
print(f"   去重后的总佣金: ${unique_total_commission:.2f}")

# 5. 从数据库获取存储的佣金
print("\n5. 从数据库获取存储的佣金...")
conn = sqlite3.connect("google_analysis.db")
cur = conn.cursor()

uid = cur.execute("SELECT id FROM users WHERE username=?", ("wj05",)).fetchone()[0]

cur.execute("""
    SELECT 
        COUNT(*) as total_orders,
        SUM(commission_amount) as total_commission
    FROM affiliate_transactions
    WHERE user_id=? AND platform='linkhaitao'
    AND transaction_time >= '2026-01-01 00:00:00'
    AND transaction_time < '2026-02-01 00:00:00'
""", (uid,))

db_result = cur.fetchone()
db_orders = db_result[0]
db_commission = db_result[1] or 0

print(f"   数据库存储订单数: {db_orders}")
print(f"   数据库存储总佣金: ${db_commission:.2f}")

conn.close()

# 6. 对比分析
print("\n" + "=" * 60)
print("对比分析")
print("=" * 60)
print(f"\nAPI数据:")
print(f"  总订单数（含重复）: {len(orders)}")
print(f"  唯一订单数: {len(orders_by_id)}")
print(f"  总佣金（含重复）: ${result.get('total_commission', 0):.2f}")
print(f"  去重后总佣金: ${unique_total_commission:.2f}")

print(f"\n数据库数据:")
print(f"  存储订单数: {db_orders}")
print(f"  存储总佣金: ${db_commission:.2f}")

print(f"\n平台数据（LinkHaitao后台）:")
print(f"  订单数: 1,508")
print(f"  总佣金: $4,881.99")

print(f"\n差异分析:")
print(f"  API去重后佣金 vs 数据库佣金: ${unique_total_commission - db_commission:.2f}")
print(f"  数据库佣金 vs 平台佣金: ${db_commission - 4881.99:.2f}")

print("\n" + "=" * 60)
print("可能的原因:")
print("=" * 60)
if abs(unique_total_commission - db_commission) > 10:
    print("1. 去重后的佣金与数据库佣金不一致，说明某些订单的佣金解析失败")
    print("2. 需要检查佣金为0的记录，看看是否真的没有佣金")
elif abs(db_commission - 4881.99) > 10:
    print("1. 数据库佣金与平台佣金不一致")
    print("2. 可能原因:")
    print("   - 平台可能包含了其他状态的订单")
    print("   - 或者某些订单的佣金字段解析失败")
    print("   - 或者日期范围不一致")
else:
    print("1. 数据基本一致，差异在可接受范围内")

print("=" * 60)

