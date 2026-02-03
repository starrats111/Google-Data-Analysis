"""
诊断同步后数据问题
检查LinkHaitao同步后的数据是否正确
"""
import sqlite3
from datetime import datetime

conn = sqlite3.connect("google_analysis.db")
cur = conn.cursor()

uid = cur.execute("SELECT id FROM users WHERE username=?", ("wj05",)).fetchone()[0]
print(f"用户 wj05 的ID: {uid}")

print("\n" + "=" * 60)
print("检查同步后的数据")
print("=" * 60)

# 1. 检查最近同步的记录（按创建时间排序）
print("\n1. 最近同步的记录（前10条）:")
cur.execute("""
    SELECT 
        transaction_id,
        transaction_time,
        order_amount,
        commission_amount,
        status,
        merchant,
        created_at
    FROM affiliate_transactions 
    WHERE user_id=? 
    AND platform='linkhaitao'
    AND transaction_time >= '2026-01-01 00:00:00'
    AND transaction_time < '2026-02-01 00:00:00'
    ORDER BY created_at DESC
    LIMIT 10
""", (uid,))

print(f"{'交易ID':<20} {'时间':<20} {'订单金额':<12} {'佣金':<10} {'状态':<10} {'商户':<30} {'创建时间':<20}")
print("-" * 120)
for row in cur.fetchall():
    tx_id, tx_time, order_amt, comm_amt, status, merchant, created_at = row
    comm_str = f"${comm_amt:.2f}" if comm_amt else "NULL"
    print(f"{str(tx_id):<20} {str(tx_time):<20} ${order_amt or 0:<11.2f} {comm_str:<10} {status or 'N/A':<10} {str(merchant or 'N/A'):<30} {str(created_at):<20}")

# 2. 检查佣金为0但订单金额不为0的记录
print("\n2. 佣金为0但订单金额不为0的记录（前20条）:")
cur.execute("""
    SELECT 
        transaction_id,
        transaction_time,
        order_amount,
        commission_amount,
        status,
        merchant
    FROM affiliate_transactions 
    WHERE user_id=? 
    AND platform='linkhaitao'
    AND transaction_time >= '2026-01-01 00:00:00'
    AND transaction_time < '2026-02-01 00:00:00'
    AND commission_amount = 0
    AND order_amount > 0
    ORDER BY transaction_time
    LIMIT 20
""", (uid,))

zero_comm_with_order = cur.fetchall()
print(f"找到 {len(zero_comm_with_order)} 条记录")
if zero_comm_with_order:
    print(f"{'交易ID':<20} {'时间':<20} {'订单金额':<12} {'佣金':<10} {'状态':<10} {'商户':<30}")
    print("-" * 100)
    for row in zero_comm_with_order:
        tx_id, tx_time, order_amt, comm_amt, status, merchant = row
        print(f"{str(tx_id):<20} {str(tx_time):<20} ${order_amt:<11.2f} ${comm_amt or 0:<9.2f} {status or 'N/A':<10} {str(merchant or 'N/A'):<30}")

# 3. 检查不同状态的订单数和佣金
print("\n3. 按状态统计:")
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
    ORDER BY status
""", (uid,))

for row in cur.fetchall():
    status, orders, comm, gmv = row
    print(f"  {status or 'NULL'}: 订单数={orders}, 佣金=${comm or 0:.2f}, GMV=${gmv or 0:.2f}")

# 4. 检查是否有重复的交易ID
print("\n4. 检查重复的交易ID:")
cur.execute("""
    SELECT 
        transaction_id,
        COUNT(*) as count,
        SUM(commission_amount) as total_commission
    FROM affiliate_transactions 
    WHERE user_id=? 
    AND platform='linkhaitao'
    AND transaction_time >= '2026-01-01 00:00:00'
    AND transaction_time < '2026-02-01 00:00:00'
    GROUP BY transaction_id
    HAVING COUNT(*) > 1
    LIMIT 10
""", (uid,))

duplicates = cur.fetchall()
if duplicates:
    print(f"  发现 {len(duplicates)} 个重复的交易ID（前10个）:")
    for tx_id, count, comm in duplicates:
        print(f"    {tx_id}: 出现{count}次, 总佣金=${comm:.2f}")
else:
    print("  ✓ 未发现重复的交易ID")

# 5. 对比平台数据
print("\n" + "=" * 60)
print("数据对比")
print("=" * 60)

cur.execute("""
    SELECT 
        COUNT(*) as total_orders,
        SUM(commission_amount) as total_commission,
        SUM(CASE WHEN status='approved' THEN commission_amount ELSE 0 END) as approved_commission,
        SUM(CASE WHEN status='rejected' THEN commission_amount ELSE 0 END) as rejected_commission
    FROM affiliate_transactions 
    WHERE user_id=? 
    AND platform='linkhaitao'
    AND transaction_time >= '2026-01-01 00:00:00'
    AND transaction_time < '2026-02-01 00:00:00'
""", (uid,))

sys_data = cur.fetchone()
print(f"\n系统数据:")
print(f"  订单数: {sys_data[0]}")
print(f"  总佣金: ${sys_data[1] or 0:.2f}")
print(f"  已付佣金(approved): ${sys_data[2] or 0:.2f}")
print(f"  拒付佣金(rejected): ${sys_data[3] or 0:.2f}")

print(f"\n平台数据（LinkHaitao后台）:")
print(f"  订单数: 1,508")
print(f"  总佣金: $4,881.99")

print(f"\n差异:")
print(f"  订单数差异: {sys_data[0] - 1508} ({'+' if sys_data[0] > 1508 else ''}{sys_data[0] - 1508})")
print(f"  佣金差异: ${(sys_data[1] or 0) - 4881.99:.2f} ({'+' if (sys_data[1] or 0) > 4881.99 else ''}{(sys_data[1] or 0) - 4881.99:.2f})")

print("\n" + "=" * 60)
print("建议:")
print("1. 检查LinkHaitao API是否返回了所有状态的订单")
print("2. 检查佣金字段是否正确解析（cashback字段）")
print("3. 可能需要手动测试LinkHaitao API，查看实际返回的数据格式")
print("=" * 60)

conn.close()

