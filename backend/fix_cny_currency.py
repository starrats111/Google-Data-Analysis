"""
修复人民币数据未转换的问题

将 CNY MCC 账号的 cost, budget, cpc 数据除以汇率转换为 USD
"""

import argparse
from sqlalchemy import create_engine, text

CNY_TO_USD_RATE = 7.2  # 人民币兑美元汇率

def main():
    parser = argparse.ArgumentParser(description='修复CNY货币数据')
    parser.add_argument('--dry-run', action='store_true', help='预览模式，不实际修改')
    args = parser.parse_args()
    
    engine = create_engine('sqlite:///google_analysis.db')
    
    print("=" * 60)
    print("修复人民币数据未转换问题")
    print("=" * 60)
    print(f"汇率: 1 USD = {CNY_TO_USD_RATE} CNY")
    print(f"模式: {'预览 (不修改)' if args.dry_run else '正式执行'}")
    print()
    
    with engine.connect() as conn:
        # 找出所有 CNY MCC 账号
        result = conn.execute(text("""
            SELECT id, mcc_name, mcc_id, currency 
            FROM google_mcc_accounts 
            WHERE currency = 'CNY'
        """))
        cny_mccs = list(result)
        
        if not cny_mccs:
            print("没有找到 CNY 货币的 MCC 账号")
            return
        
        print(f"找到 {len(cny_mccs)} 个 CNY MCC 账号:")
        for mcc in cny_mccs:
            print(f"  ID {mcc[0]}: {mcc[1]} ({mcc[2]})")
        print()
        
        # 统计受影响的数据
        mcc_ids = [str(mcc[0]) for mcc in cny_mccs]
        mcc_ids_str = ','.join(mcc_ids)
        
        result = conn.execute(text(f"""
            SELECT mcc_id, COUNT(*) as records, SUM(cost) as total_cost
            FROM google_ads_api_data 
            WHERE mcc_id IN ({mcc_ids_str})
            GROUP BY mcc_id
        """))
        
        stats = list(result)
        total_records = 0
        total_cost_before = 0
        
        print("受影响的数据统计:")
        for stat in stats:
            mcc_name = next((m[1] for m in cny_mccs if m[0] == stat[0]), 'Unknown')
            cost_before = float(stat[2])
            cost_after = cost_before / CNY_TO_USD_RATE
            print(f"  MCC {stat[0]} ({mcc_name}):")
            print(f"    记录数: {stat[1]}")
            print(f"    费用: ¥{cost_before:.2f} → ${cost_after:.2f}")
            total_records += stat[1]
            total_cost_before += cost_before
        
        print()
        print(f"总计: {total_records} 条记录")
        print(f"费用变化: ¥{total_cost_before:.2f} → ${total_cost_before / CNY_TO_USD_RATE:.2f}")
        print(f"差额: ${total_cost_before - total_cost_before / CNY_TO_USD_RATE:.2f}")
        print()
        
        if args.dry_run:
            print("预览模式，未修改数据。")
            print("使用 --dry-run=false 或不带参数执行来实际修改数据。")
            return
        
        # 执行更新
        print("正在更新数据...")
        
        for mcc in cny_mccs:
            mcc_id = mcc[0]
            result = conn.execute(text(f"""
                UPDATE google_ads_api_data 
                SET cost = cost / {CNY_TO_USD_RATE},
                    budget = budget / {CNY_TO_USD_RATE},
                    cpc = cpc / {CNY_TO_USD_RATE}
                WHERE mcc_id = {mcc_id}
            """))
            print(f"  MCC {mcc_id} ({mcc[1]}): 已更新")
        
        conn.commit()
        
        print()
        print("✓ 数据修复完成!")
        print()
        
        # 验证结果
        result = conn.execute(text(f"""
            SELECT mcc_id, SUM(cost) as total_cost
            FROM google_ads_api_data 
            WHERE mcc_id IN ({mcc_ids_str})
            GROUP BY mcc_id
        """))
        
        print("修复后费用:")
        for stat in result:
            mcc_name = next((m[1] for m in cny_mccs if m[0] == stat[0]), 'Unknown')
            print(f"  MCC {stat[0]} ({mcc_name}): ${float(stat[1]):.2f}")

if __name__ == "__main__":
    main()

