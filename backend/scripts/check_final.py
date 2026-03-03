"""最终对比脚本：查找 wj04/wj05 数据差异的根因"""
import requests
import json

BASE = "https://api.google-data-analysis.top"

def login(username, password):
    r = requests.post(f"{BASE}/api/auth/login", data={"username": username, "password": password})
    if r.status_code == 200:
        return r.json().get("access_token")
    return None

def api_get(token, path, params=None):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(f"{BASE}{path}", headers=headers, params=params or {}, timeout=30)
    if r.status_code == 200:
        return r.json()
    print(f"  GET {path} => {r.status_code}")
    return None

tokens = {}
for user, pwd in [("wj04", "wj123456"), ("wj05", "wj123456")]:
    t = login(user, pwd)
    if t:
        tokens[user] = t
        print(f"{user}: logged in")

for user in ["wj04", "wj05"]:
    if user not in tokens:
        continue
    
    print(f"\n{'=' * 120}")
    print(f"  {user} - by-campaign (past7days) 完整数据")
    print(f"{'=' * 120}")
    
    bc = api_get(tokens[user], "/api/google-ads-aggregate/by-campaign", {
        "date_range_type": "past7days", "status": "ENABLED"
    })
    if not bc:
        continue
    
    # 打印完整响应结构
    if isinstance(bc, dict):
        print(f"  响应 keys: {list(bc.keys())}")
        campaigns = bc.get("campaigns", [])
        date_range = bc.get("date_range", "?")
        currency = bc.get("currency", "?")
        print(f"  日期范围: {date_range}, 货币: {currency}")
        print(f"  共 {len(campaigns)} 个广告系列\n")
        
        # 打印每个广告系列的完整数据
        print(f"  {'广告系列':<55} {'费用':>9} {'展示':>7} {'点击':>5} {'CPC':>7} {'预算':>8} {'IS_BL':>8} {'IS_RL':>8} {'CTR':>6}")
        print("  " + "-" * 120)
        
        total_cost = 0
        total_imp = 0
        total_clicks = 0
        
        for c in sorted(campaigns, key=lambda x: -(x.get("cost", 0) or 0)):
            name = c.get("campaign_name", "?")[:55]
            cost = c.get("cost", 0) or 0
            imp = c.get("impressions", 0) or 0
            clicks = c.get("clicks", 0) or 0
            cpc = c.get("cpc", 0) or 0
            budget = c.get("budget", 0) or 0
            is_bl = c.get("is_budget_lost", 0) or 0
            is_rl = c.get("is_rank_lost", 0) or 0
            ctr = c.get("ctr", 0) or 0
            
            total_cost += cost
            total_imp += imp
            total_clicks += clicks
            
            # 标记有差异的
            flag = ""
            if cost == 0 and imp == 0:
                flag = " [双0]"
            
            print(f"  {name:<55} {cost:>9.2f} {imp:>7} {clicks:>5} {cpc:>7.3f} {budget:>8.2f} {is_bl:>8.4f} {is_rl:>8.4f} {ctr:>6.2f}{flag}")
        
        print(f"\n  汇总: 费用={total_cost:.2f}, 展示={total_imp}, 点击={total_clicks}")
        
        # 打印第一个广告系列的完整 JSON 看看有没有其他字段
        if campaigns:
            print(f"\n  第一个广告系列完整字段: {json.dumps(campaigns[0], ensure_ascii=False)}")
