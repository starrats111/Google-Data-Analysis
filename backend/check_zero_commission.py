"""
检查佣金为0或NULL的记录，分析原因
"""
import sqlite3
import json

conn = sqlite3.connect("google_analysis.db")
cur = conn.cursor()

uid = cur.execute("SELECT id FROM users WHERE username=?", ("wj05",)).fetchone()[0]

print("=" * 60)
print("检查佣金为0或NULL的记录")
print("=" * 60)

# 1. 统计佣金为0或NULL的记录
cur.execute("""
    SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN commission_amount = 0 THEN 1 ELSE 0 END) as zero_count,
        SUM(CASE WHEN commission_amount IS NULL THEN 1 ELSE 0 END) as null_count
    FROM affiliate_transactions 
    WHERE user_id=? 
    AND platform='linkhaitao'
    AND transaction_time >= '2026-01-01 00:00:00'
    AND transaction_time < '2026-02-01 00:00:00'
    AND (commission_amount IS NULL OR commission_amount = 0)
""", (uid,))

stats = cur.fetchone()
print(f"\n总计: {stats[0]} 条")
print(f"  佣金为0: {stats[1]} 条")
print(f"  佣金为NULL: {stats[2]} 条")

# 2. 查看这些记录的详细信息（前20条）
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
    AND (commission_amount IS NULL OR commission_amount = 0)
    ORDER BY transaction_time
    LIMIT 20
""", (uid,))

print(f"\n前20条佣金为0或NULL的记录:")
print(f"{'交易ID':<20} {'时间':<20} {'订单金额':<12} {'佣金':<10} {'状态':<10} {'商户':<30}")
print("-" * 100)

for row in cur.fetchall():
    tx_id, tx_time, order_amt, comm_amt, status, merchant = row
    comm_str = "NULL" if comm_amt is None else f"${comm_amt:.2f}"
    print(f"{str(tx_id):<20} {str(tx_time):<20} ${order_amt or 0:<11.2f} {comm_str:<10} {status or 'N/A':<10} {str(merchant or 'N/A'):<30}")

# 3. 检查这些记录的原始数据（如果有raw_data字段）
# 注意：affiliate_transactions表可能没有raw_data字段，需要检查表结构
cur.execute("PRAGMA table_info(affiliate_transactions)")
columns = [col[1] for col in cur.fetchall()]

if 'raw_data' in columns:
    print(f"\n检查原始数据（raw_data字段）...")
    cur.execute("""
        SELECT transaction_id, raw_data
        FROM affiliate_transactions 
        WHERE user_id=? 
        AND platform='linkhaitao'
        AND transaction_time >= '2026-01-01 00:00:00'
        AND transaction_time < '2026-02-01 00:00:00'
        AND (commission_amount IS NULL OR commission_amount = 0)
        LIMIT 5
    """, (uid,))
    
    for tx_id, raw_data in cur.fetchall():
        print(f"\n交易ID: {tx_id}")
        if raw_data:
            try:
                data = json.loads(raw_data) if isinstance(raw_data, str) else raw_data
                print(f"  原始数据: {json.dumps(data, indent=2, ensure_ascii=False)}")
            except:
                print(f"  原始数据（无法解析）: {raw_data}")
        else:
            print("  无原始数据")

# 4. 按日期统计佣金为0的记录数量
cur.execute("""
    SELECT 
        DATE(transaction_time) as date,
        COUNT(*) as count,
        SUM(order_amount) as total_order_amount
    FROM affiliate_transactions 
    WHERE user_id=? 
    AND platform='linkhaitao'
    AND transaction_time >= '2026-01-01 00:00:00'
    AND transaction_time < '2026-02-01 00:00:00'
    AND (commission_amount IS NULL OR commission_amount = 0)
    GROUP BY DATE(transaction_time)
    ORDER BY date
""", (uid,))

print(f"\n按日期统计佣金为0或NULL的记录:")
print(f"{'日期':<15} {'数量':<10} {'订单金额总和':<15}")
print("-" * 40)
for date, count, total_amt in cur.fetchall():
    print(f"{date:<15} {count:<10} ${total_amt or 0:<14.2f}")

# 5. 计算如果这些记录的佣金正确，应该增加多少佣金
# 假设这些记录的佣金应该是订单金额的某个比例（比如LinkHaitao的平均佣金率）
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
    print(f"\n平均佣金率: {avg_rate * 100:.2f}%")
    
    cur.execute("""
        SELECT SUM(order_amount)
        FROM affiliate_transactions 
        WHERE user_id=? 
        AND platform='linkhaitao'
        AND transaction_time >= '2026-01-01 00:00:00'
        AND transaction_time < '2026-02-01 00:00:00'
        AND (commission_amount IS NULL OR commission_amount = 0)
        AND order_amount > 0
    """, (uid,))
    
    total_order_amt = cur.fetchone()[0] or 0
    estimated_commission = total_order_amt * avg_rate
    print(f"佣金为0的订单总金额: ${total_order_amt:.2f}")
    print(f"估算应得佣金（按平均率）: ${estimated_commission:.2f}")

print("\n" + "=" * 60)
print("建议:")
print("1. 检查LinkHaitao同步逻辑，确保佣金字段正确解析")
print("2. 重新同步这些佣金为0的记录")
print("3. 检查LinkHaitao API返回的数据格式，确认佣金字段名称")
print("=" * 60)

conn.close()

