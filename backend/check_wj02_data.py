"""
检查 wj02 用户的平台数据
"""
import sys
sys.path.insert(0, '.')

from sqlalchemy import create_engine, text
from datetime import datetime

engine = create_engine('sqlite:///google_analysis.db')

with engine.connect() as conn:
    # 1. 获取 wj02 的用户信息
    print("=" * 60)
    print("1. wj02 用户信息")
    print("=" * 60)
    result = conn.execute(text("""
        SELECT id, username, role, team_id FROM users WHERE username = 'wj02'
    """))
    user = result.fetchone()
    if user:
        print(f"  用户ID: {user[0]}, 用户名: {user[1]}, 角色: {user[2]}, 团队ID: {user[3]}")
        user_id = user[0]
    else:
        print("  未找到 wj02 用户")
        sys.exit(1)
    
    # 2. 查看 wj02 关联的平台账号
    print("\n" + "=" * 60)
    print("2. wj02 关联的平台账号")
    print("=" * 60)
    result = conn.execute(text("""
        SELECT aa.id, aa.account_name, aa.username, ap.platform_code, ap.platform_name
        FROM affiliate_accounts aa
        LEFT JOIN affiliate_platforms ap ON aa.platform_id = ap.id
        WHERE aa.user_id = :user_id
    """), {"user_id": user_id})
    accounts = list(result)
    for acc in accounts:
        print(f"  账号ID: {acc[0]}, 名称: {acc[1]}, 用户名: {acc[2]}, 平台: {acc[3]} ({acc[4]})")
    
    account_ids = [acc[0] for acc in accounts]
    
    # 3. 查看 wj02 的交易数据汇总（按平台）
    print("\n" + "=" * 60)
    print("3. wj02 交易数据汇总（2026-02-01 至 2026-02-12，按平台）")
    print("=" * 60)
    result = conn.execute(text("""
        SELECT 
            platform,
            COUNT(*) as order_count,
            SUM(commission_amount) as total_commission,
            SUM(CASE WHEN status = 'rejected' THEN commission_amount ELSE 0 END) as rejected_commission,
            MIN(transaction_time) as first_tx,
            MAX(transaction_time) as last_tx
        FROM affiliate_transactions
        WHERE user_id = :user_id
          AND transaction_time >= '2026-02-01'
          AND transaction_time < '2026-02-13'
        GROUP BY platform
        ORDER BY total_commission DESC
    """), {"user_id": user_id})
    
    total_orders = 0
    total_commission = 0
    total_rejected = 0
    
    print(f"  {'平台':<10} {'订单数':>10} {'总佣金':>15} {'拒付佣金':>15} {'净佣金':>15}")
    print("  " + "-" * 70)
    for row in result:
        platform = row[0]
        orders = row[1]
        commission = float(row[2] or 0)
        rejected = float(row[3] or 0)
        net = commission - rejected
        
        total_orders += orders
        total_commission += commission
        total_rejected += rejected
        
        print(f"  {platform:<10} {orders:>10} ${commission:>14.2f} ${rejected:>14.2f} ${net:>14.2f}")
    
    print("  " + "-" * 70)
    print(f"  {'合计':<10} {total_orders:>10} ${total_commission:>14.2f} ${total_rejected:>14.2f} ${total_commission - total_rejected:>14.2f}")
    
    # 4. 查看每天的数据
    print("\n" + "=" * 60)
    print("4. wj02 每日交易数据（按日期）")
    print("=" * 60)
    result = conn.execute(text("""
        SELECT 
            DATE(transaction_time) as date,
            COUNT(*) as order_count,
            SUM(commission_amount) as total_commission
        FROM affiliate_transactions
        WHERE user_id = :user_id
          AND transaction_time >= '2026-02-01'
          AND transaction_time < '2026-02-13'
        GROUP BY DATE(transaction_time)
        ORDER BY date
    """), {"user_id": user_id})
    
    for row in result:
        print(f"  {row[0]}: {row[1]} 订单, ${float(row[2] or 0):.2f}")
    
    # 5. 检查是否有重复数据
    print("\n" + "=" * 60)
    print("5. 检查重复交易数据")
    print("=" * 60)
    result = conn.execute(text("""
        SELECT platform, transaction_id, COUNT(*) as cnt
        FROM affiliate_transactions
        WHERE user_id = :user_id
          AND transaction_time >= '2026-02-01'
          AND transaction_time < '2026-02-13'
        GROUP BY platform, transaction_id
        HAVING COUNT(*) > 1
        LIMIT 10
    """), {"user_id": user_id})
    
    duplicates = list(result)
    if duplicates:
        print("  发现重复交易:")
        for row in duplicates:
            print(f"    平台: {row[0]}, 交易ID: {row[1]}, 重复次数: {row[2]}")
    else:
        print("  无重复交易数据")
    
    # 6. 对比 PM 平台的数据
    print("\n" + "=" * 60)
    print("6. PM (Partnermatic) 平台详细数据")
    print("=" * 60)
    result = conn.execute(text("""
        SELECT 
            status,
            COUNT(*) as order_count,
            SUM(commission_amount) as total_commission
        FROM affiliate_transactions
        WHERE user_id = :user_id
          AND platform IN ('pm', 'partnermatic')
          AND transaction_time >= '2026-02-01'
          AND transaction_time < '2026-02-13'
        GROUP BY status
    """), {"user_id": user_id})
    
    print(f"  {'状态':<15} {'订单数':>10} {'佣金':>15}")
    print("  " + "-" * 45)
    for row in result:
        print(f"  {row[0] or 'NULL':<15} {row[1]:>10} ${float(row[2] or 0):>14.2f}")
    
    # 7. 对比 CG 平台的数据
    print("\n" + "=" * 60)
    print("7. CG (CollabGlow) 平台详细数据")
    print("=" * 60)
    result = conn.execute(text("""
        SELECT 
            status,
            COUNT(*) as order_count,
            SUM(commission_amount) as total_commission
        FROM affiliate_transactions
        WHERE user_id = :user_id
          AND platform IN ('cg', 'collabglow')
          AND transaction_time >= '2026-02-01'
          AND transaction_time < '2026-02-13'
        GROUP BY status
    """), {"user_id": user_id})
    
    print(f"  {'状态':<15} {'订单数':>10} {'佣金':>15}")
    print("  " + "-" * 45)
    for row in result:
        print(f"  {row[0] or 'NULL':<15} {row[1]:>10} ${float(row[2] or 0):>14.2f}")

    # 8. 检查最近同步时间
    print("\n" + "=" * 60)
    print("8. 最近同步时间")
    print("=" * 60)
    result = conn.execute(text("""
        SELECT platform, MAX(updated_at) as last_sync
        FROM affiliate_transactions
        WHERE user_id = :user_id
        GROUP BY platform
    """), {"user_id": user_id})
    
    for row in result:
        print(f"  {row[0]}: {row[1]}")

print("\n完成检查！")

