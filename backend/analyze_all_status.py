"""
分析所有状态的订单和佣金分布
检查为什么金额对不上
"""
import sqlite3
from datetime import datetime

conn = sqlite3.connect("google_analysis.db")
cur = conn.cursor()

uid = cur.execute("SELECT id FROM users WHERE username=?", ("wj05",)).fetchone()[0]

print("=" * 60)
print("分析所有状态的订单和佣金分布")
print("=" * 60)

# 1. 按原始状态统计
print("\n1. 按原始状态（raw_status）统计:")
cur.execute("""
    SELECT 
        raw_status,
        COUNT(*) as orders,
        SUM(commission_amount) as total_commission,
        SUM(order_amount) as total_gmv
    FROM affiliate_transactions 
    WHERE user_id=? 
    AND platform='linkhaitao'
    AND transaction_time >= '2026-01-01 00:00:00'
    AND transaction_time < '2026-02-01 00:00:00'
    GROUP BY raw_status
    ORDER BY orders DESC
""", (uid,))

print(f"{'原始状态':<30} {'订单数':<10} {'总佣金':<15} {'总GMV':<15}")
print("-" * 70)
for row in cur.fetchall():
    raw_status, orders, comm, gmv = row
    print(f"{str(raw_status or 'NULL'):<30} {orders:<10} ${comm or 0:<14.2f} ${gmv or 0:<14.2f}")

# 2. 按映射后的状态统计
print("\n2. 按映射后的状态（status）统计:")
cur.execute("""
    SELECT 
        status,
        COUNT(*) as orders,
        SUM(commission_amount) as total_commission,
        SUM(order_amount) as total_gmv
    FROM affiliate_transactions 
    WHERE user_id=? 
    AND platform='linkhaitao'
    AND transaction_time >= '2026-01-01 00:00:00'
    AND transaction_time < '2026-02-01 00:00:00'
    GROUP BY status
    ORDER BY orders DESC
""", (uid,))

print(f"{'映射后状态':<20} {'订单数':<10} {'总佣金':<15} {'总GMV':<15}")
print("-" * 60)
total_by_status = {}
for row in cur.fetchall():
    status, orders, comm, gmv = row
    total_by_status[status] = {'orders': orders, 'commission': comm or 0, 'gmv': gmv or 0}
    print(f"{str(status or 'NULL'):<20} {orders:<10} ${comm or 0:<14.2f} ${gmv or 0:<14.2f}")

# 3. 总计
print("\n3. 总计（所有状态）:")
cur.execute("""
    SELECT 
        COUNT(*) as total_orders,
        SUM(commission_amount) as total_commission,
        SUM(order_amount) as total_gmv,
        SUM(CASE WHEN status='approved' THEN commission_amount ELSE 0 END) as approved_commission,
        SUM(CASE WHEN status='rejected' THEN commission_amount ELSE 0 END) as rejected_commission
    FROM affiliate_transactions 
    WHERE user_id=? 
    AND platform='linkhaitao'
    AND transaction_time >= '2026-01-01 00:00:00'
    AND transaction_time < '2026-02-01 00:00:00'
""", (uid,))

total = cur.fetchone()
print(f"  总订单数: {total[0]}")
print(f"  总佣金（所有状态）: ${total[1] or 0:.2f}")
print(f"  总GMV: ${total[2] or 0:.2f}")
print(f"  已付佣金（approved）: ${total[3] or 0:.2f}")
print(f"  拒付佣金（rejected）: ${total[4] or 0:.2f}")

# 4. 检查佣金为0的记录
print("\n4. 佣金为0的记录统计:")
cur.execute("""
    SELECT 
        COUNT(*) as zero_comm_count,
        SUM(order_amount) as total_order_amount
    FROM affiliate_transactions 
    WHERE user_id=? 
    AND platform='linkhaitao'
    AND transaction_time >= '2026-01-01 00:00:00'
    AND transaction_time < '2026-02-01 00:00:00'
    AND commission_amount = 0
""", (uid,))

zero_comm = cur.fetchone()
print(f"  佣金为0的记录数: {zero_comm[0]}")
print(f"  这些记录的订单金额总和: ${zero_comm[1] or 0:.2f}")

# 5. 对比平台数据
print("\n" + "=" * 60)
print("数据对比")
print("=" * 60)
print(f"\n系统数据:")
print(f"  订单数: {total[0]}")
print(f"  总佣金（所有状态）: ${total[1] or 0:.2f}")
print(f"  已付佣金（approved）: ${total[3] or 0:.2f}")
print(f"  拒付佣金（rejected）: ${total[4] or 0:.2f}")

print(f"\n平台数据（LinkHaitao后台）:")
print(f"  订单数: 1,508")
print(f"  总佣金: $4,881.99")

print(f"\n差异:")
print(f"  订单数差异: {total[0] - 1508} ({'+' if total[0] > 1508 else ''}{total[0] - 1508})")
print(f"  佣金差异: ${(total[1] or 0) - 4881.99:.2f} ({'+' if (total[1] or 0) > 4881.99 else ''}{(total[1] or 0) - 4881.99:.2f})")

# 6. 分析可能的原因
print("\n" + "=" * 60)
print("可能的原因:")
print("=" * 60)
if (total[1] or 0) < 4881.99:
    missing_commission = 4881.99 - (total[1] or 0)
    print(f"1. 系统佣金比平台少 ${missing_commission:.2f}")
    print(f"2. 有 {zero_comm[0]} 条佣金为0的记录，订单金额总和 ${zero_comm[1] or 0:.2f}")
    print(f"3. 可能原因:")
    print(f"   - 这些订单的佣金字段解析失败（字段名不匹配）")
    print(f"   - LinkHaitao API返回的数据格式与预期不符")
    print(f"   - 某些状态的订单没有正确同步")
    print(f"   - 需要直接测试LinkHaitao API查看实际返回的数据")

print("\n建议:")
print("1. 运行 test_linkhaitao_api.py 直接测试API，查看实际返回的数据格式")
print("2. 检查这些佣金为0的记录，看看是否真的没有佣金")
print("3. 确认LinkHaitao API是否返回了所有状态的订单")
print("=" * 60)

conn.close()

