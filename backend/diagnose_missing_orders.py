"""
诊断为什么API返回3854条订单，但系统只存储了1510条
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.services.linkhaitao_service import LinkHaitaoService
from app.database import SessionLocal
from app.models.affiliate_transaction import AffiliateTransaction
from app.models.affiliate_account import AffiliateAccount
from app.models.user import User
from datetime import datetime
import sqlite3

# Token
TOKEN = sys.argv[1] if len(sys.argv) > 1 else "5LabOMCN8XgtNIpH"

print("=" * 60)
print("诊断缺失订单问题")
print("=" * 60)

# 1. 从API获取所有订单
print("\n1. 从API获取所有订单...")
service = LinkHaitaoService(token=TOKEN)
result = service.sync_commissions_and_orders("2026-01-01", "2026-01-31")
orders = result.get("data", {}).get("orders", [])
print(f"   API返回订单数: {len(orders)}")

# 2. 从数据库获取已存储的订单
print("\n2. 从数据库获取已存储的订单...")
db = SessionLocal()
try:
    user = db.query(User).filter(User.username == "wj05").first()
    if not user:
        print("❌ 未找到用户 wj05")
        sys.exit(1)
    
    account = db.query(AffiliateAccount).filter(
        AffiliateAccount.user_id == user.id,
        AffiliateAccount.platform_id.in_(
            db.query().filter_by(name="LinkHaitao").first().id if db.query().filter_by(name="LinkHaitao").first() else []
        )
    ).first()
    
    # 直接查询数据库
    conn = sqlite3.connect("google_analysis.db")
    cur = conn.cursor()
    
    uid = cur.execute("SELECT id FROM users WHERE username=?", ("wj05",)).fetchone()[0]
    
    cur.execute("""
        SELECT transaction_id, transaction_time, commission_amount, order_amount, status
        FROM affiliate_transactions
        WHERE user_id=? AND platform='linkhaitao'
        AND transaction_time >= '2026-01-01 00:00:00'
        AND transaction_time < '2026-02-01 00:00:00'
    """, (uid,))
    
    stored_orders = cur.fetchall()
    stored_tx_ids = {row[0] for row in stored_orders}
    print(f"   数据库存储订单数: {len(stored_orders)}")
    
    # 3. 对比API订单和数据库订单
    print("\n3. 对比API订单和数据库订单...")
    api_tx_ids = set()
    api_tx_ids_with_duplicates = []
    
    for order in orders:
        tx_id = order.get("order_id") or order.get("id") or order.get("transaction_id")
        if tx_id:
            if tx_id in api_tx_ids:
                api_tx_ids_with_duplicates.append(tx_id)
            api_tx_ids.add(tx_id)
    
    print(f"   API唯一订单ID数: {len(api_tx_ids)}")
    print(f"   数据库唯一订单ID数: {len(stored_tx_ids)}")
    print(f"   API中重复的订单ID数: {len(api_tx_ids_with_duplicates)}")
    
    if api_tx_ids_with_duplicates:
        print(f"\n   前10个重复的订单ID:")
        for tx_id in api_tx_ids_with_duplicates[:10]:
            print(f"     {tx_id}")
    
    # 4. 找出API中有但数据库中没有的订单
    missing_tx_ids = api_tx_ids - stored_tx_ids
    print(f"\n4. 缺失的订单:")
    print(f"   API中有但数据库中没有的订单数: {len(missing_tx_ids)}")
    
    if missing_tx_ids:
        # 统计缺失订单的状态和佣金
        missing_by_status = {}
        missing_commission = 0
        missing_count = 0
        
        for order in orders:
            tx_id = order.get("order_id") or order.get("id") or order.get("transaction_id")
            if tx_id in missing_tx_ids:
                status = order.get("status", "unknown")
                commission = order.get("commission") or 0
                missing_count += 1
                missing_commission += commission
                
                if status not in missing_by_status:
                    missing_by_status[status] = {"count": 0, "commission": 0}
                missing_by_status[status]["count"] += 1
                missing_by_status[status]["commission"] += commission
        
        print(f"\n   缺失订单统计:")
        print(f"     总订单数: {missing_count}")
        print(f"     总佣金: ${missing_commission:.2f}")
        print(f"\n   按状态统计:")
        for status, stats in sorted(missing_by_status.items()):
            print(f"     {status}: {stats['count']} 条, 佣金: ${stats['commission']:.2f}")
        
        # 显示前10个缺失订单的详细信息
        print(f"\n   前10个缺失订单的详细信息:")
        count = 0
        for order in orders:
            if count >= 10:
                break
            tx_id = order.get("order_id") or order.get("id") or order.get("transaction_id")
            if tx_id in missing_tx_ids:
                print(f"     {tx_id}: 状态={order.get('status')}, 佣金=${order.get('commission') or 0:.2f}, 订单金额=${order.get('amount') or 0:.2f}, 商户={order.get('merchant')}")
                count += 1
    
    # 5. 找出数据库中有但API中没有的订单（不应该有）
    extra_tx_ids = stored_tx_ids - api_tx_ids
    if extra_tx_ids:
        print(f"\n5. 数据库中有但API中没有的订单数: {len(extra_tx_ids)}")
        print(f"   (这些可能是历史数据或手动添加的数据)")
    
    conn.close()
    
finally:
    db.close()

print("\n" + "=" * 60)
print("建议:")
print("1. 如果缺失订单很多，需要检查同步逻辑")
print("2. 如果有重复的订单ID，需要去重处理")
print("3. 如果缺失订单的佣金总和接近差异，说明这些订单没有正确保存")
print("=" * 60)

