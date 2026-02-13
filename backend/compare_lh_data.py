"""
对比系统数据和平台数据的差异
"""
import sqlite3
from datetime import datetime
from collections import defaultdict

conn = sqlite3.connect("google_analysis.db")
cur = conn.cursor()

# 获取wj05的用户ID
uid = cur.execute("SELECT id FROM users WHERE username=?", ("wj05",)).fetchone()[0]
print(f"用户 wj05 的ID: {uid}")

# 系统数据统计（2026-01-01 到 2026-01-31）
print("\n" + "=" * 60)
print("系统数据统计（2026-01-01 到 2026-01-31）")
print("=" * 60)

# 1. 按状态统计
cur.execute("""
    SELECT 
        status,
        COUNT(*) as orders,
        SUM(commission_amount) as commission,
        SUM(order_amount) as gmv
    FROM affiliate_transactions 
    WHERE user_id=? 
    AND platform='linkhaitao'
    AND transaction_time >= '2026-01-01 00:00:00'
    AND transaction_time < '2026-02-01 00:00:00'
    GROUP BY status
    ORDER BY status
""", (uid,))

print("\n按状态统计:")
status_stats = {}
for row in cur.fetchall():
    status, orders, commission, gmv = row
    status_stats[status] = {
        'orders': orders or 0,
        'commission': commission or 0,
        'gmv': gmv or 0
    }
    print(f"  {status}: 订单数={orders or 0}, 佣金=${commission or 0:.2f}, GMV=${gmv or 0:.2f}")

# 2. 总计（所有状态）
cur.execute("""
    SELECT 
        COUNT(*) as total_orders,
        SUM(commission_amount) as total_commission,
        SUM(order_amount) as total_gmv
    FROM affiliate_transactions 
    WHERE user_id=? 
    AND platform='linkhaitao'
    AND transaction_time >= '2026-01-01 00:00:00'
    AND transaction_time < '2026-02-01 00:00:00'
""", (uid,))

total = cur.fetchone()
print(f"\n总计（所有状态）:")
print(f"  订单数: {total[0] or 0}")
print(f"  总佣金: ${total[1] or 0:.2f}")
print(f"  总GMV: ${total[2] or 0:.2f}")

# 3. 按日期统计（查看是否有遗漏的日期）
cur.execute("""
    SELECT 
        DATE(transaction_time) as date,
        COUNT(*) as orders,
        SUM(commission_amount) as commission
    FROM affiliate_transactions 
    WHERE user_id=? 
    AND platform='linkhaitao'
    AND transaction_time >= '2026-01-01 00:00:00'
    AND transaction_time < '2026-02-01 00:00:00'
    GROUP BY DATE(transaction_time)
    ORDER BY date
""", (uid,))

print(f"\n按日期统计（前10天和后10天）:")
date_stats = cur.fetchall()
for i, (date, orders, commission) in enumerate(date_stats):
    if i < 10 or i >= len(date_stats) - 10:
        print(f"  {date}: 订单数={orders}, 佣金=${commission or 0:.2f}")

# 4. 检查是否有重复或异常数据
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
    print(f"\n⚠️  发现重复的交易ID（前10个）:")
    for tx_id, count, comm in duplicates:
        print(f"  {tx_id}: 出现{count}次, 总佣金=${comm:.2f}")
else:
    print(f"\n✓ 未发现重复的交易ID")

# 5. 检查是否有commission_amount为0或NULL的记录
cur.execute("""
    SELECT COUNT(*) 
    FROM affiliate_transactions 
    WHERE user_id=? 
    AND platform='linkhaitao'
    AND transaction_time >= '2026-01-01 00:00:00'
    AND transaction_time < '2026-02-01 00:00:00'
    AND (commission_amount IS NULL OR commission_amount = 0)
""", (uid,))

zero_comm = cur.fetchone()[0]
if zero_comm > 0:
    print(f"\n⚠️  发现 {zero_comm} 条佣金为0或NULL的记录")

# 6. 平台数据（从图片中看到的）
print("\n" + "=" * 60)
print("平台数据（LinkHaitao后台）")
print("=" * 60)
print("  订单数量: 1,508")
print("  总佣金: $4,881.99")
print("  总销售额: $158,155.71")

# 7. 差异分析
print("\n" + "=" * 60)
print("差异分析")
print("=" * 60)
sys_orders = total[0] or 0
sys_commission = total[1] or 0
platform_orders = 1508
platform_commission = 4881.99

print(f"\n订单数差异:")
print(f"  系统: {sys_orders}")
print(f"  平台: {platform_orders}")
print(f"  差异: {sys_orders - platform_orders} ({'+' if sys_orders > platform_orders else ''}{sys_orders - platform_orders})")

print(f"\n佣金差异:")
print(f"  系统: ${sys_commission:.2f}")
print(f"  平台: ${platform_commission:.2f}")
print(f"  差异: ${sys_commission - platform_commission:.2f} ({'+' if sys_commission > platform_commission else ''}{sys_commission - platform_commission:.2f})")

if sys_commission < platform_commission:
    print(f"\n⚠️  系统佣金比平台少 ${platform_commission - sys_commission:.2f}")
    print("  可能原因:")
    print("  1. 数据同步不完整（某些订单未同步）")
    print("  2. 平台包含所有状态的佣金，系统可能只包含部分状态")
    print("  3. 日期范围不一致（时区问题）")
    print("  4. 某些订单的佣金字段解析失败（为0或NULL）")

conn.close()
















