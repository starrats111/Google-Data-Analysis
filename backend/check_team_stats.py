"""临时脚本：检查团队统计数据"""
from sqlalchemy import create_engine, text
from datetime import datetime
import calendar

engine = create_engine('sqlite:///google_analysis.db')

now = datetime.now()
start_date = now.replace(day=1).strftime('%Y-%m-%d')
_, last_day = calendar.monthrange(now.year, now.month)
end_date = now.replace(day=last_day).strftime('%Y-%m-%d')

print(f"=== 查询日期范围: {start_date} ~ {end_date} ===\n")

with engine.connect() as conn:
    # 获取所有团队
    teams_result = conn.execute(text("SELECT id, team_code, team_name FROM teams"))
    teams = list(teams_result)
    
    for team_id, team_code, team_name in teams:
        print(f"--- {team_name} ({team_code}) ---")
        
        # 获取团队成员
        members_result = conn.execute(text(f"SELECT id, username FROM users WHERE team_id = {team_id}"))
        members = list(members_result)
        member_ids = [m[0] for m in members]
        
        print(f"  成员数: {len(members)}")
        print(f"  成员: {[m[1] for m in members]}")
        
        if not member_ids:
            print(f"  费用: $0.00")
            print(f"  佣金: $0.00")
            print(f"  ROI: 0%\n")
            continue
        
        ids_str = ','.join(map(str, member_ids))
        
        # 查询费用
        cost_result = conn.execute(text(
            f"SELECT SUM(cost) FROM google_ads_api_data "
            f"WHERE user_id IN ({ids_str}) "
            f"AND date >= '{start_date}' AND date <= '{end_date}'"
        ))
        total_cost = float(cost_result.scalar() or 0)
        
        # 查询佣金
        comm_result = conn.execute(text(
            f"SELECT SUM(commission_amount) FROM affiliate_transactions "
            f"WHERE user_id IN ({ids_str}) "
            f"AND status != 'rejected' "
            f"AND transaction_time >= '{start_date}' AND transaction_time <= '{end_date}'"
        ))
        total_comm = float(comm_result.scalar() or 0)
        
        profit = total_comm - total_cost
        roi = (profit / total_cost * 100) if total_cost > 0 else 0
        
        print(f"  费用: ${total_cost:.2f}")
        print(f"  佣金: ${total_comm:.2f}")
        print(f"  利润: ${profit:.2f}")
        print(f"  ROI: {roi:.2f}%\n")

print("=== 检查完成 ===")

