"""
检查LinkHaitao API是否返回了所有状态的订单
特别是Effective、Preliminary Effective等状态
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.services.linkhaitao_service import LinkHaitaoService
from collections import defaultdict

# Token
TOKEN = sys.argv[1] if len(sys.argv) > 1 else "5LabOMCN8XgtNIpH"

print("=" * 60)
print("检查LinkHaitao API返回的所有状态订单")
print("=" * 60)

# 1. 从API获取所有订单
print("\n1. 从API获取所有订单...")
service = LinkHaitaoService(token=TOKEN)
result = service.sync_commissions_and_orders("2026-01-01", "2026-01-31")
orders = result.get("data", {}).get("orders", [])

print(f"   API返回订单数: {len(orders)}")
print(f"   API返回总佣金: ${result.get('total_commission', 0):.2f}")

# 2. 统计所有不同的状态值
print("\n2. 统计所有不同的状态值...")
status_stats = defaultdict(lambda: {"count": 0, "commission": 0, "gmv": 0})

for order in orders:
    status = order.get("status", "unknown")
    commission = order.get("commission") or 0
    amount = order.get("amount") or 0
    
    status_stats[status]["count"] += 1
    status_stats[status]["commission"] += commission
    status_stats[status]["gmv"] += amount

print(f"\n状态统计:")
print(f"{'状态':<30} {'订单数':<10} {'总佣金':<15} {'总GMV':<15}")
print("-" * 70)
for status in sorted(status_stats.keys()):
    stats = status_stats[status]
    print(f"{str(status):<30} {stats['count']:<10} ${stats['commission']:<14.2f} ${stats['gmv']:<14.2f}")

# 3. 检查是否有Effective等状态
print("\n3. 检查是否有Effective等状态...")
effective_statuses = ["effective", "preliminary effective", "preliminary expired"]
found_effective = False

for status in status_stats.keys():
    status_lower = str(status).lower()
    for eff_status in effective_statuses:
        if eff_status in status_lower:
            found_effective = True
            print(f"   找到状态: {status} ({status_stats[status]['count']} 条, 佣金: ${status_stats[status]['commission']:.2f})")

if not found_effective:
    print("   ❌ 未找到Effective、Preliminary Effective等状态")
    print("   可能原因:")
    print("   1. API只返回了expired和untreated状态的订单")
    print("   2. 或者需要调整API参数来获取所有状态的订单")
    print("   3. 或者这些状态的订单在其他日期范围内")

# 4. 对比平台数据
print("\n" + "=" * 60)
print("对比分析")
print("=" * 60)
total_commission = sum(stats["commission"] for stats in status_stats.values())
total_orders = sum(stats["count"] for stats in status_stats.values())

print(f"\nAPI数据（所有状态）:")
print(f"  总订单数: {total_orders}")
print(f"  总佣金: ${total_commission:.2f}")

print(f"\n平台数据（LinkHaitao后台）:")
print(f"  订单数: 1,508")
print(f"  总佣金: $4,881.99")

print(f"\n差异:")
print(f"  订单数差异: {total_orders - 1508} ({'+' if total_orders > 1508 else ''}{total_orders - 1508})")
print(f"  佣金差异: ${total_commission - 4881.99:.2f} ({'+' if total_commission > 4881.99 else ''}{total_commission - 4881.99:.2f})")

if abs(total_commission - 4881.99) < 20:
    print("\n✓ API返回的总佣金与平台数据基本一致（差异在可接受范围内）")
    print("  说明API返回了所有状态的订单")
else:
    print("\n⚠️ API返回的总佣金与平台数据不一致")
    print("  可能原因:")
    print("  1. API没有返回所有状态的订单")
    print("  2. 或者某些订单的佣金字段解析失败")

print("=" * 60)

