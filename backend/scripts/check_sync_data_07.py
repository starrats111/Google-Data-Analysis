#!/usr/bin/env python3
"""
07的同步数据检查脚本 - 检查费用数据是否正确同步
"""
import sys
from pathlib import Path

# 添加backend目录到路径
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

from app.database import SessionLocal
from app.models.google_ads_api_data import GoogleAdsApiData, GoogleMccAccount
from datetime import date, timedelta

def check_sync_data():
    """检查同步数据"""
    db = SessionLocal()
    
    try:
        print("=== 检查同步数据 ===")
        print("")
        
        # 1. 检查所有MCC账号
        mcc_accounts = db.query(GoogleMccAccount).filter(
            GoogleMccAccount.is_active == True
        ).all()
        
        print(f"找到 {len(mcc_accounts)} 个激活的MCC账号")
        print("")
        
        # 2. 检查最近7天的数据
        today = date.today()
        total_cost = 0
        total_count = 0
        
        for mcc in mcc_accounts:
            print(f"MCC: {mcc.mcc_name} (ID: {mcc.mcc_id})")
            
            # 检查最近7天的数据
            for i in range(7):
                check_date = today - timedelta(days=i+1)
                count = db.query(GoogleAdsApiData).filter(
                    GoogleAdsApiData.mcc_id == mcc.id,
                    GoogleAdsApiData.date == check_date
                ).count()
                
                if count > 0:
                    # 计算该日期的总费用
                    data_list = db.query(GoogleAdsApiData).filter(
                        GoogleAdsApiData.mcc_id == mcc.id,
                        GoogleAdsApiData.date == check_date
                    ).all()
                    
                    date_cost = sum(d.cost for d in data_list if d.cost)
                    total_cost += date_cost
                    total_count += count
                    
                    print(f"  {check_date.isoformat()}: {count} 条数据, 费用: ${date_cost:.2f}")
            
            print("")
        
        print(f"=== 汇总 ===")
        print(f"最近7天总数据条数: {total_count}")
        print(f"最近7天总费用: ${total_cost:.2f}")
        print("")
        
        # 3. 检查今天是否有新数据
        today_count = db.query(GoogleAdsApiData).filter(
            GoogleAdsApiData.date == today - timedelta(days=1)  # 昨天
        ).count()
        
        print(f"昨天（{today - timedelta(days=1)}）的数据条数: {today_count}")
        
        if today_count == 0:
            print("⚠️ 警告: 昨天没有数据，可能需要同步")
        else:
            print("✅ 昨天有数据")
        
    except Exception as e:
        print(f"❌ 检查失败: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()

if __name__ == "__main__":
    check_sync_data()


"""
07的同步数据检查脚本 - 检查费用数据是否正确同步
"""
import sys
from pathlib import Path

# 添加backend目录到路径
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

from app.database import SessionLocal
from app.models.google_ads_api_data import GoogleAdsApiData, GoogleMccAccount
from datetime import date, timedelta

def check_sync_data():
    """检查同步数据"""
    db = SessionLocal()
    
    try:
        print("=== 检查同步数据 ===")
        print("")
        
        # 1. 检查所有MCC账号
        mcc_accounts = db.query(GoogleMccAccount).filter(
            GoogleMccAccount.is_active == True
        ).all()
        
        print(f"找到 {len(mcc_accounts)} 个激活的MCC账号")
        print("")
        
        # 2. 检查最近7天的数据
        today = date.today()
        total_cost = 0
        total_count = 0
        
        for mcc in mcc_accounts:
            print(f"MCC: {mcc.mcc_name} (ID: {mcc.mcc_id})")
            
            # 检查最近7天的数据
            for i in range(7):
                check_date = today - timedelta(days=i+1)
                count = db.query(GoogleAdsApiData).filter(
                    GoogleAdsApiData.mcc_id == mcc.id,
                    GoogleAdsApiData.date == check_date
                ).count()
                
                if count > 0:
                    # 计算该日期的总费用
                    data_list = db.query(GoogleAdsApiData).filter(
                        GoogleAdsApiData.mcc_id == mcc.id,
                        GoogleAdsApiData.date == check_date
                    ).all()
                    
                    date_cost = sum(d.cost for d in data_list if d.cost)
                    total_cost += date_cost
                    total_count += count
                    
                    print(f"  {check_date.isoformat()}: {count} 条数据, 费用: ${date_cost:.2f}")
            
            print("")
        
        print(f"=== 汇总 ===")
        print(f"最近7天总数据条数: {total_count}")
        print(f"最近7天总费用: ${total_cost:.2f}")
        print("")
        
        # 3. 检查今天是否有新数据
        today_count = db.query(GoogleAdsApiData).filter(
            GoogleAdsApiData.date == today - timedelta(days=1)  # 昨天
        ).count()
        
        print(f"昨天（{today - timedelta(days=1)}）的数据条数: {today_count}")
        
        if today_count == 0:
            print("⚠️ 警告: 昨天没有数据，可能需要同步")
        else:
            print("✅ 昨天有数据")
        
    except Exception as e:
        print(f"❌ 检查失败: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()

if __name__ == "__main__":
    check_sync_data()









