"""
诊断 API 问题：检查用户、权限和数据
"""
import sqlite3
from sqlalchemy import create_engine, func, case
from sqlalchemy.orm import sessionmaker
from datetime import datetime
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.models.affiliate_transaction import AffiliateTransaction
from app.models.user import User

engine = create_engine('sqlite:///google_analysis.db', echo=False)
Session = sessionmaker(bind=engine)
db = Session()

try:
    print("=" * 60)
    print("诊断 API 问题")
    print("=" * 60)
    
    # 1. 列出所有用户
    print("\n1. 所有用户列表:")
    users = db.query(User).all()
    for u in users:
        print(f"   ID: {u.id}, 用户名: {u.username}, 角色: {u.role}")
    
    # 2. 检查 wj05 的数据
    print("\n2. wj05 用户数据统计:")
    wj05 = db.query(User).filter(User.username == 'wj05').first()
    if wj05:
        # 检查各平台的数据量
        platforms = db.query(
            AffiliateTransaction.platform,
            func.count(AffiliateTransaction.id).label('count')
        ).filter(
            AffiliateTransaction.user_id == wj05.id
        ).group_by(AffiliateTransaction.platform).all()
        
        for p, count in platforms:
            print(f"   平台 {p}: {count} 条记录")
        
        # 检查 LH 平台在指定日期范围的数据
        begin = datetime(2026, 1, 1)
        end = datetime(2026, 1, 31, 23, 59, 59)
        
        lh_count = db.query(AffiliateTransaction).filter(
            AffiliateTransaction.user_id == wj05.id,
            AffiliateTransaction.platform == 'linkhaitao',
            AffiliateTransaction.transaction_time >= begin,
            AffiliateTransaction.transaction_time <= end
        ).count()
        
        print(f"\n   LH平台 (2026-01-01 ~ 2026-01-31): {lh_count} 条原始记录")
    
    # 3. 模拟 API 查询（按日期+平台+商户聚合）
    print("\n3. 模拟 API 聚合查询:")
    if wj05:
        begin_date = datetime(2026, 1, 1).date()
        end_date = datetime(2026, 1, 31).date()
        begin_datetime = datetime.combine(begin_date, datetime.min.time())
        end_datetime = datetime.combine(end_date, datetime.max.time())
        
        query = db.query(
            func.date(AffiliateTransaction.transaction_time).label('date'),
            AffiliateTransaction.platform,
            AffiliateTransaction.merchant,
            func.count(AffiliateTransaction.id).label('total_orders'),
            func.sum(AffiliateTransaction.commission_amount).label('total_commission')
        ).filter(
            AffiliateTransaction.user_id == wj05.id,
            AffiliateTransaction.platform == 'linkhaitao',
            AffiliateTransaction.transaction_time >= begin_datetime,
            AffiliateTransaction.transaction_time <= end_datetime
        ).group_by(
            func.date(AffiliateTransaction.transaction_time),
            AffiliateTransaction.platform,
            AffiliateTransaction.merchant
        )
        
        results = query.all()
        print(f"   聚合后记录数: {len(results)}")
        if results:
            print(f"   前3条记录:")
            for i, r in enumerate(results[:3], 1):
                print(f"     {i}. {r.date} | {r.platform} | {r.merchant or 'N/A'} | "
                      f"订单: {r.total_orders} | 佣金: ${r.total_commission:.2f}")
    
    # 4. 检查可能的用户ID不匹配问题
    print("\n4. 检查所有用户的 LH 数据:")
    all_users_lh = db.query(
        AffiliateTransaction.user_id,
        func.count(AffiliateTransaction.id).label('count')
    ).filter(
        AffiliateTransaction.platform == 'linkhaitao',
        AffiliateTransaction.transaction_time >= datetime(2026, 1, 1),
        AffiliateTransaction.transaction_time < datetime(2026, 2, 1)
    ).group_by(AffiliateTransaction.user_id).all()
    
    for uid, count in all_users_lh:
        user = db.query(User).filter(User.id == uid).first()
        username = user.username if user else f"未知用户(ID:{uid})"
        print(f"   用户 {username} (ID: {uid}): {count} 条记录")
    
    print("\n" + "=" * 60)
    print("建议:")
    print("1. 确认前端登录的用户是 wj05")
    print("2. 检查浏览器 Network 标签中 API 请求的响应内容")
    print("3. 检查 API 响应中是否包含数据，还是返回空数组")
    print("4. 如果响应为空，检查用户认证和权限")
    print("=" * 60)
    
finally:
    db.close()

