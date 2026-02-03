"""
测试 LH 平台数据查询
"""
import sqlite3
from sqlalchemy import create_engine, func, case
from sqlalchemy.orm import sessionmaker
from datetime import datetime
import sys
import os

# 添加项目路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.models.affiliate_transaction import AffiliateTransaction
from app.models.user import User

# 连接数据库
engine = create_engine('sqlite:///google_analysis.db', echo=False)
Session = sessionmaker(bind=engine)
db = Session()

try:
    # 获取 wj05 用户
    user = db.query(User).filter(User.username == 'wj05').first()
    if not user:
        print("❌ 未找到用户 wj05")
        sys.exit(1)
    
    print(f"✓ 找到用户: {user.username} (ID: {user.id}, Role: {user.role})")
    
    # 测试查询参数
    begin_date = "2026-01-01"
    end_date = "2026-01-31"
    platform = "LH"  # 前端传递的值
    
    # 解析日期
    begin = datetime.strptime(begin_date, "%Y-%m-%d").date()
    end = datetime.strptime(end_date, "%Y-%m-%d").date()
    begin_datetime = datetime.combine(begin, datetime.min.time())
    end_datetime = datetime.combine(end, datetime.max.time())
    
    print(f"\n查询参数:")
    print(f"  日期范围: {begin_date} ~ {end_date}")
    print(f"  平台代码: {platform}")
    print(f"  开始时间: {begin_datetime}")
    print(f"  结束时间: {end_datetime}")
    
    # 平台代码映射
    platform_lower = platform.lower().strip()
    platform_code_map = {
        'lh': 'linkhaitao',
        'linkhaitao': 'linkhaitao',
        'link-haitao': 'linkhaitao',
        'link_haitao': 'linkhaitao',
    }
    platform_final = platform_code_map.get(platform_lower, platform_lower)
    print(f"  映射后的平台代码: {platform_final}")
    
    # 构建查询（模拟 API 逻辑）
    query = db.query(
        func.date(AffiliateTransaction.transaction_time).label('date'),
        AffiliateTransaction.platform,
        AffiliateTransaction.merchant,
        func.count(AffiliateTransaction.id).label('total_orders'),
        func.sum(AffiliateTransaction.order_amount).label('gmv'),
        func.sum(AffiliateTransaction.commission_amount).label('total_commission'),
        func.sum(
            case(
                (AffiliateTransaction.status == "approved", AffiliateTransaction.commission_amount),
                else_=0
            )
        ).label('approved_commission'),
        func.sum(
            case(
                (AffiliateTransaction.status == "rejected", AffiliateTransaction.commission_amount),
                else_=0
            )
        ).label('rejected_commission')
    ).filter(
        AffiliateTransaction.transaction_time >= begin_datetime,
        AffiliateTransaction.transaction_time <= end_datetime
    )
    
    # 权限控制：员工只能看自己的数据
    if user.role == "employee":
        query = query.filter(AffiliateTransaction.user_id == user.id)
        print(f"\n✓ 应用权限过滤: user_id = {user.id}")
    
    # 平台筛选
    query = query.filter(AffiliateTransaction.platform == platform_final)
    print(f"✓ 应用平台过滤: platform = '{platform_final}'")
    
    # 按日期+平台+商户分组
    query = query.group_by(
        func.date(AffiliateTransaction.transaction_time),
        AffiliateTransaction.platform,
        AffiliateTransaction.merchant
    )
    
    # 执行查询
    results = query.all()
    
    print(f"\n查询结果:")
    print(f"  找到 {len(results)} 条记录")
    
    if results:
        print(f"\n前5条记录:")
        for i, r in enumerate(results[:5], 1):
            print(f"  {i}. 日期: {r.date}, 平台: {r.platform}, 商户: {r.merchant or 'N/A'}, "
                  f"订单数: {r.total_orders}, 佣金: ${r.total_commission:.2f}")
    else:
        print("\n❌ 没有找到数据！")
        print("\n调试信息:")
        # 检查原始数据
        raw_count = db.query(AffiliateTransaction).filter(
            AffiliateTransaction.user_id == user.id,
            AffiliateTransaction.platform == platform_final,
            AffiliateTransaction.transaction_time >= begin_datetime,
            AffiliateTransaction.transaction_time <= end_datetime
        ).count()
        print(f"  原始数据条数（无分组）: {raw_count}")
        
        # 检查平台代码
        platforms = db.query(AffiliateTransaction.platform).filter(
            AffiliateTransaction.user_id == user.id
        ).distinct().all()
        print(f"  用户 {user.username} 的所有平台: {[p[0] for p in platforms]}")
        
finally:
    db.close()

