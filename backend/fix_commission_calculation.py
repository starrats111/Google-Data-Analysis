"""
修复佣金计算问题
分析为什么去重后的佣金与平台数据差异这么大
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.services.linkhaitao_service import LinkHaitaoService
from collections import defaultdict
import sqlite3

# Token
TOKEN = sys.argv[1] if len(sys.argv) > 1 else "5LabOMCN8XgtNIpH"

print("=" * 60)
print("修复佣金计算问题")
print("=" * 60)

# 1. 从API获取所有订单
print("\n1. 从API获取所有订单...")
service = LinkHaitaoService(token=TOKEN)
result = service.sync_commissions_and_orders("2026-01-01", "2026-01-31")
orders = result.get("data", {}).get("orders", [])

print(f"   API返回订单数: {len(orders)}")
print(f"   API返回总佣金: ${result.get('total_commission', 0):.2f}")

# 2. 按订单ID分组，对于重复订单，取最大佣金
print("\n2. 按订单ID分组，对于重复订单取最大佣金...")
orders_by_id = defaultdict(list)
for order in orders:
    tx_id = order.get("order_id") or order.get("id") or order.get("transaction_id")
    if tx_id:
        orders_by_id[tx_id].append(order)

# 对于每个订单ID，取最大佣金
unique_orders_max_commission = {}
for tx_id, order_list in orders_by_id.items():
    max_commission = max([order.get("commission") or 0 for order in order_list])
    unique_orders_max_commission[tx_id] = max_commission

total_max_commission = sum(unique_orders_max_commission.values())
print(f"   唯一订单数: {len(unique_orders_max_commission)}")
print(f"   去重后总佣金（取最大）: ${total_max_commission:.2f}")

# 3. 对于重复订单，取第一条的佣金
unique_orders_first_commission = {}
for tx_id, order_list in orders_by_id.items():
    first_commission = order_list[0].get("commission") or 0
    unique_orders_first_commission[tx_id] = first_commission

total_first_commission = sum(unique_orders_first_commission.values())
print(f"   去重后总佣金（取第一条）: ${total_first_commission:.2f}")

# 4. 对于重复订单，取最后一条的佣金
unique_orders_last_commission = {}
for tx_id, order_list in orders_by_id.items():
    last_commission = order_list[-1].get("commission") or 0
    unique_orders_last_commission[tx_id] = last_commission

total_last_commission = sum(unique_orders_last_commission.values())
print(f"   去重后总佣金（取最后一条）: ${total_last_commission:.2f}")

# 5. 对于重复订单，求和（如果平台是这样计算的）
unique_orders_sum_commission = {}
for tx_id, order_list in orders_by_id.items():
    sum_commission = sum([order.get("commission") or 0 for order in order_list])
    unique_orders_sum_commission[tx_id] = sum_commission

total_sum_commission = sum(unique_orders_sum_commission.values())
print(f"   去重后总佣金（求和）: ${total_sum_commission:.2f}")

# 6. 从数据库获取存储的佣金
print("\n3. 从数据库获取存储的佣金...")
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

# 7. 对比分析
print("\n" + "=" * 60)
print("对比分析")
print("=" * 60)
print(f"\nAPI数据:")
print(f"  总订单数（含重复）: {len(orders)}")
print(f"  唯一订单数: {len(unique_orders_max_commission)}")
print(f"  总佣金（含重复）: ${result.get('total_commission', 0):.2f}")

print(f"\n去重后佣金（不同策略）:")
print(f"  取最大佣金: ${total_max_commission:.2f}")
print(f"  取第一条佣金: ${total_first_commission:.2f}")
print(f"  取最后一条佣金: ${total_last_commission:.2f}")
print(f"  求和: ${total_sum_commission:.2f}")

print(f"\n数据库数据:")
print(f"  存储订单数: {db_orders}")
print(f"  存储总佣金: ${db_commission:.2f}")

print(f"\n平台数据（LinkHaitao后台）:")
print(f"  订单数: 1,508")
print(f"  总佣金: $4,881.99")

print(f"\n差异分析:")
print(f"  取最大佣金 vs 平台: ${total_max_commission - 4881.99:.2f}")
print(f"  取第一条佣金 vs 平台: ${total_first_commission - 4881.99:.2f}")
print(f"  取最后一条佣金 vs 平台: ${total_last_commission - 4881.99:.2f}")
print(f"  求和 vs 平台: ${total_sum_commission - 4881.99:.2f}")
print(f"  数据库 vs 平台: ${db_commission - 4881.99:.2f}")

# 找出最接近平台数据的策略
strategies = {
    "取最大佣金": total_max_commission,
    "取第一条佣金": total_first_commission,
    "取最后一条佣金": total_last_commission,
    "求和": total_sum_commission,
}

best_strategy = min(strategies.items(), key=lambda x: abs(x[1] - 4881.99))
print(f"\n最接近平台数据的策略: {best_strategy[0]} (差异: ${abs(best_strategy[1] - 4881.99):.2f})")

print("\n" + "=" * 60)
print("建议:")
if abs(best_strategy[1] - 4881.99) < 20:
    print(f"1. 使用'{best_strategy[0]}'策略来处理重复订单的佣金")
    print("2. 更新同步逻辑，使用该策略")
else:
    print("1. 所有策略都与平台数据差异较大")
    print("2. 可能需要检查平台是否包含了其他状态的订单")
    print("3. 或者某些订单的佣金字段解析失败")
print("=" * 60)

