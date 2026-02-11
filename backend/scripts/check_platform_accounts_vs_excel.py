"""
对比数据库中的平台账号与Excel记录
找出错误的账号并删除
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pandas as pd
from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform

def main():
    # 读取Excel文件
    excel_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'excel', '平台账号记录.xlsx')
    
    print(f"读取Excel文件: {excel_path}")
    print("=" * 80)
    
    try:
        df = pd.read_excel(excel_path)
        print("Excel文件内容:")
        print(df.to_string())
        print()
    except Exception as e:
        print(f"读取Excel失败: {e}")
        return
    
    print("=" * 80)
    print("数据库中的平台账号:")
    print("=" * 80)
    
    db = SessionLocal()
    
    try:
        # 获取所有用户
        users = db.query(User).filter(User.role == 'employee').order_by(User.username).all()
        
        # 获取所有平台
        platforms = {p.id: p.platform_name for p in db.query(AffiliatePlatform).all()}
        
        for user in users:
            accounts = db.query(AffiliateAccount).filter(
                AffiliateAccount.user_id == user.id
            ).all()
            
            if accounts:
                print(f"\n【{user.username}】")
                for acc in accounts:
                    platform_name = platforms.get(acc.platform_id, '?')
                    status = "活跃" if acc.is_active else "禁用"
                    print(f"  ID={acc.id:3d} | {platform_name:4s} | {acc.account_name:20s} | {status}")
        
    finally:
        db.close()

if __name__ == "__main__":
    main()

