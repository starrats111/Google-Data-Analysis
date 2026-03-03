"""临时脚本：对比 wj04/wj05 的 L7D 数据差异"""
import sqlite3
from collections import defaultdict

conn = sqlite3.connect('google_analysis.db')
c = conn.cursor()

# 1. 用户信息
print("=" * 80)
print("1. 用户和MCC信息")
print("=" * 80)
c.execute("SELECT id, username, role FROM users WHERE username IN ('wj04','wj05')")
users = c.fetchall()
user_map = {}
for u in users:
    user_map[u[1]] = u[0]
    print(f"  用户: ID={u[0]}, username={u[1]}, role={u[2]}")
    c.execute("SELECT id, mcc_name, mcc_id, is_active FROM google_mcc_accounts WHERE user_id=?", (u[0],))
    for m in c.fetchall():
        print(f"    MCC: db_id={m[0]}, name={m[1]}, mcc_id={m[2]}, active={m[3]}")

# 如果找不到 wj04/wj05，尝试模糊搜索
if not users:
    print("  未找到 wj04/wj05，搜索所有用户:")
    c.execute("SELECT id, username FROM users")
    for u in c.fetchall():
        print(f"    ID={u[0]}, username={u[1]}")

def analyze_user(username, uid):
    print(f"\n{'=' * 80}")
    print(f"  {username} (ID={uid}) 广告系列 L7D 数据 (2026-02-19 ~ 2026-02-25)")
    print(f"{'=' * 80}")
    c.execute("""
        SELECT g.campaign_name, g.date, g.impressions, g.clicks, g.cost, g.cpc, 
               g.budget, g.is_budget_lost, g.is_rank_lost, g.status, g.mcc_id
        FROM google_ads_api_data g
        WHERE g.user_id = ?
          AND g.date >= '2026-02-19' AND g.date <= '2026-02-25'
          AND g.status = '已启用'
        ORDER BY g.campaign_name, g.date
    """, (uid,))
    rows = c.fetchall()
    
    campaigns = defaultdict(lambda: {
        "days": [], "total_imp": 0, "total_clicks": 0, "total_cost": 0, 
        "max_budget": 0, "is_bl": [], "is_rl": [], "mcc_id": None
    })
    for r in rows:
        name = r[0]
        campaigns[name]["days"].append(r[1])
        campaigns[name]["total_imp"] += r[2] or 0
        campaigns[name]["total_clicks"] += r[3] or 0
        campaigns[name]["total_cost"] += r[4] or 0
        campaigns[name]["max_budget"] = max(campaigns[name]["max_budget"], r[6] or 0)
        if r[7] is not None:
            campaigns[name]["is_bl"].append(r[7])
        if r[8] is not None:
            campaigns[name]["is_rl"].append(r[8])
        campaigns[name]["mcc_id"] = r[10]
    
    print(f"\n  共 {len(campaigns)} 个已启用广告系列, {len(rows)} 条日数据")
    print(f"\n  {'广告系列':<55} {'天':>2} {'展示':>7} {'点击':>5} {'费用':>9} {'预算':>7}")
    print("  " + "-" * 100)
    for name, d in sorted(campaigns.items(), key=lambda x: -x[1]["total_cost"]):
        print(f"  {name[:55]:<55} {len(d['days']):>2} {d['total_imp']:>7} {d['total_clicks']:>5} {d['total_cost']:>9.2f} {d['max_budget']:>7.2f}")
    
    # 检查缺失天数
    all_dates = ['2026-02-19','2026-02-20','2026-02-21','2026-02-22','2026-02-23','2026-02-24','2026-02-25']
    missing_any = False
    for name, d in sorted(campaigns.items()):
        missing = [dt for dt in all_dates if dt not in d["days"]]
        if missing:
            if not missing_any:
                print(f"\n  缺失天数的广告系列:")
                missing_any = True
            print(f"    {name[:60]}: 只有{len(d['days'])}天, 缺少 {missing}")
    if not missing_any:
        print(f"\n  所有广告系列均有完整7天数据")
    
    return campaigns

for username in ['wj04', 'wj05']:
    if username in user_map:
        analyze_user(username, user_map[username])
    else:
        print(f"\n  {username} 未找到!")

conn.close()
