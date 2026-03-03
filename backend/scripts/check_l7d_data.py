"""获取关键广告系列的每日明细数据"""
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
    return None

# 查看 gemini/l7d-data 端点获取每日明细
tokens = {}
for user, pwd in [("wj04", "wj123456"), ("wj05", "wj123456")]:
    t = login(user, pwd)
    if t:
        tokens[user] = t

for user in ["wj04", "wj05"]:
    if user not in tokens:
        continue
    
    print(f"\n{'=' * 120}")
    print(f"  {user} - L7D 数据 (gemini/l7d-data)")
    print(f"{'=' * 120}")
    
    data = api_get(tokens[user], "/api/gemini/l7d-data", {
        "start_date": "2026-02-19",
        "end_date": "2026-02-25"
    })
    if data:
        campaigns = data.get("campaigns", [])
        summary = data.get("summary", {})
        print(f"  共 {len(campaigns)} 个广告系列")
        print(f"  summary: {json.dumps(summary, ensure_ascii=False)}")
        
        # 打印每个广告系列
        print(f"\n  {'广告系列':<55} {'费用':>8} {'IS_BL':>8} {'IS_RL':>8} {'天数':>4}")
        print("  " + "-" * 90)
        for c in sorted(campaigns, key=lambda x: -(x.get("cost", 0) or 0)):
            name = c.get("campaign_name", "?")[:55]
            cost = c.get("cost", 0) or 0
            is_bl = c.get("is_budget_lost", 0) or 0
            is_rl = c.get("is_rank_lost", 0) or 0
            days = c.get("data_days", 0) or 0
            print(f"  {name:<55} {cost:>8.2f} {is_bl:>8.4f} {is_rl:>8.4f} {days:>4}")
    else:
        print("  无数据")

# 也获取 2/21-2/27 的数据（和 by-campaign 同期）
for user in ["wj04", "wj05"]:
    if user not in tokens:
        continue
    
    print(f"\n{'=' * 120}")
    print(f"  {user} - L7D 数据 (2/21-2/27, 和 by-campaign 同期)")
    print(f"{'=' * 120}")
    
    data = api_get(tokens[user], "/api/gemini/l7d-data", {
        "start_date": "2026-02-21",
        "end_date": "2026-02-27"
    })
    if data:
        campaigns = data.get("campaigns", [])
        print(f"  共 {len(campaigns)} 个广告系列")
        
        print(f"\n  {'广告系列':<55} {'费用':>8} {'IS_BL':>8} {'IS_RL':>8} {'天数':>4}")
        print("  " + "-" * 90)
        for c in sorted(campaigns, key=lambda x: -(x.get("cost", 0) or 0)):
            name = c.get("campaign_name", "?")[:55]
            cost = c.get("cost", 0) or 0
            is_bl = c.get("is_budget_lost", 0) or 0
            is_rl = c.get("is_rank_lost", 0) or 0
            days = c.get("data_days", 0) or 0
            print(f"  {name:<55} {cost:>8.2f} {is_bl:>8.4f} {is_rl:>8.4f} {days:>4}")
    else:
        print("  无数据")
