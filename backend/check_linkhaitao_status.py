"""
检查LinkHaitao订单的状态值
"""
import sqlite3

conn = sqlite3.connect("google_analysis.db")
cur = conn.cursor()

uid = cur.execute("SELECT id FROM users WHERE username=?", ("wj05",)).fetchone()[0]

print("=" * 60)
print("检查LinkHaitao订单的状态值")
print("=" * 60)

# 1. 检查所有不同的状态值（包括raw_status）
cur.execute("""
    SELECT 
        raw_status,
        status,
        COUNT(*) as count
    FROM affiliate_transactions 
    WHERE user_id=? 
    AND platform='linkhaitao'
    AND transaction_time >= '2026-01-01 00:00:00'
    AND transaction_time < '2026-02-01 00:00:00'
    GROUP BY raw_status, status
    ORDER BY count DESC
""", (uid,))

print("\n1. 状态值统计（raw_status -> status）:")
print(f"{'原始状态':<30} {'映射后状态':<20} {'数量':<10}")
print("-" * 60)
for row in cur.fetchall():
    raw_status, status, count = row
    print(f"{str(raw_status or 'NULL'):<30} {str(status or 'NULL'):<20} {count:<10}")

# 2. 检查佣金为0但订单金额不为0的记录的原始状态
print("\n2. 佣金为0但订单金额不为0的记录的原始状态:")
cur.execute("""
    SELECT 
        raw_status,
        status,
        COUNT(*) as count,
        SUM(order_amount) as total_amount
    FROM affiliate_transactions 
    WHERE user_id=? 
    AND platform='linkhaitao'
    AND transaction_time >= '2026-01-01 00:00:00'
    AND transaction_time < '2026-02-01 00:00:00'
    AND commission_amount = 0
    AND order_amount > 0
    GROUP BY raw_status, status
    ORDER BY count DESC
""", (uid,))

for row in cur.fetchall():
    raw_status, status, count, total = row
    print(f"  {str(raw_status or 'NULL'):<30} {str(status or 'NULL'):<20} 数量={count}, 总金额=${total or 0:.2f}")

# 3. 检查是否有其他状态值的订单（从LinkHaitao API可能返回的状态）
print("\n3. 检查LinkHaitao可能的状态值:")
# LinkHaitao可能的状态值：untreated, pending, approved, rejected, cancelled等
possible_statuses = ['untreated', 'pending', 'approved', 'rejected', 'cancelled', 'confirmed', 'paid', 'settled']
for status_val in possible_statuses:
    cur.execute("""
        SELECT COUNT(*) 
        FROM affiliate_transactions 
        WHERE user_id=? 
        AND platform='linkhaitao'
        AND transaction_time >= '2026-01-01 00:00:00'
        AND transaction_time < '2026-02-01 00:00:00'
        AND (raw_status = ? OR status = ?)
    """, (uid, status_val, status_val))
    count = cur.fetchone()[0]
    if count > 0:
        print(f"  {status_val}: {count} 条记录")

print("\n" + "=" * 60)
print("建议:")
print("1. 检查LinkHaitao API实际返回的状态值")
print("2. 确认状态映射是否正确（可能需要添加LinkHaitao特定的状态映射）")
print("3. 检查佣金为0的记录是否真的没有佣金，还是字段解析问题")
print("=" * 60)

conn.close()















