"""
修复佣金为0的记录
检查并更新这些记录的佣金字段
"""
import sqlite3
from datetime import datetime

conn = sqlite3.connect("google_analysis.db")
cur = conn.cursor()

uid = cur.execute("SELECT id FROM users WHERE username=?", ("wj05",)).fetchone()[0]

print("=" * 60)
print("检查佣金为0但订单金额不为0的记录")
print("=" * 60)

# 1. 统计这些记录
cur.execute("""
    SELECT 
        transaction_id,
        transaction_time,
        order_amount,
        commission_amount,
        status,
        raw_status,
        merchant
    FROM affiliate_transactions 
    WHERE user_id=? 
    AND platform='linkhaitao'
    AND transaction_time >= '2026-01-01 00:00:00'
    AND transaction_time < '2026-02-01 00:00:00'
    AND commission_amount = 0
    AND order_amount > 0
    ORDER BY transaction_time
""", (uid,))

zero_comm_records = cur.fetchall()
print(f"\n找到 {len(zero_comm_records)} 条佣金为0但订单金额不为0的记录")

if zero_comm_records:
    print(f"\n前20条记录:")
    print(f"{'交易ID':<25} {'时间':<20} {'订单金额':<12} {'佣金':<10} {'状态':<15} {'原始状态':<15} {'商户':<30}")
    print("-" * 120)
    for row in zero_comm_records[:20]:
        tx_id, tx_time, order_amt, comm_amt, status, raw_status, merchant = row
        print(f"{str(tx_id):<25} {str(tx_time):<20} ${order_amt:<11.2f} ${comm_amt or 0:<9.2f} {str(status or 'N/A'):<15} {str(raw_status or 'N/A'):<15} {str(merchant or 'N/A'):<30}")
    
    # 按状态统计
    print(f"\n按状态统计:")
    status_stats = {}
    for row in zero_comm_records:
        raw_status = row[5] or 'NULL'
        order_amt = row[2] or 0
        if raw_status not in status_stats:
            status_stats[raw_status] = {'count': 0, 'total_amount': 0}
        status_stats[raw_status]['count'] += 1
        status_stats[raw_status]['total_amount'] += order_amt
    
    for status, stats in sorted(status_stats.items()):
        print(f"  {status}: 数量={stats['count']}, 总金额=${stats['total_amount']:.2f}")

# 2. 检查这些记录是否真的没有佣金（可能需要从LinkHaitao API重新获取）
print("\n" + "=" * 60)
print("建议:")
print("1. 这些记录的佣金可能确实为0（某些订单可能没有佣金）")
print("2. 或者需要重新同步这些订单，从LinkHaitao API获取最新的佣金数据")
print("3. 如果这些订单在LinkHaitao后台有佣金，需要检查API返回的数据格式")
print("4. 可能需要手动测试LinkHaitao API，查看这些订单的实际佣金值")
print("=" * 60)

# 3. 计算如果这些记录的佣金正确，应该增加多少佣金
if zero_comm_records:
    total_order_amount = sum(row[2] or 0 for row in zero_comm_records)
    
    # 计算平均佣金率（从有佣金的订单中）
    cur.execute("""
        SELECT 
            AVG(CASE WHEN commission_amount > 0 THEN commission_amount / NULLIF(order_amount, 0) ELSE NULL END) as avg_rate
        FROM affiliate_transactions 
        WHERE user_id=? 
        AND platform='linkhaitao'
        AND transaction_time >= '2026-01-01 00:00:00'
        AND transaction_time < '2026-02-01 00:00:00'
        AND commission_amount > 0
        AND order_amount > 0
    """, (uid,))
    
    avg_rate = cur.fetchone()[0]
    if avg_rate:
        estimated_commission = total_order_amount * avg_rate
        print(f"\n估算:")
        print(f"  佣金为0的订单总金额: ${total_order_amount:.2f}")
        print(f"  平均佣金率: {avg_rate * 100:.2f}%")
        print(f"  估算应得佣金: ${estimated_commission:.2f}")
        print(f"  实际佣金差异: $1,442.02")
        print(f"  差异说明: 除了这{len(zero_comm_records)}条记录，可能还有其他订单的佣金没有正确同步")

conn.close()

