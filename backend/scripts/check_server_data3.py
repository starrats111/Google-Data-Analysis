"""深入对比 wj04/wj05 的数据差异 - 查看每日明细"""
import requests
import json
from collections import defaultdict

BASE = "https://api.google-data-analysis.top"

def login(username, password):
    r = requests.post(f"{BASE}/api/auth/login", data={"username": username, "password": password})
    if r.status_code == 200:
        return r.json().get("access_token")
    return None

def api_get(token, path, params=None):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(f"{BASE}{path}", headers=headers, params=params or {})
    if r.status_code == 200:
        return r.json()
    return None

def api_post(token, path, params=None):
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.post(f"{BASE}{path}", headers=headers, params=params or {})
    if r.status_code == 200:
        return r.json()
    else:
        print(f"  POST {path} => {r.status_code}: {r.text[:300]}")
        return None

# 登录
tokens = {}
for user, pwd in [("wj04", "wj123456"), ("wj05", "wj123456")]:
    t = login(user, pwd)
    if t:
        tokens[user] = t
        print(f"{user}: logged in")

# 对每个用户：
# 1. 获取 by-campaign (past7days) - 这是"Google Ads后台"显示的数据
# 2. 触发 L7D 分析 - 这是"L7D分析"显示的数据
# 3. 对比两者

for user in ["wj04", "wj05"]:
    if user not in tokens:
        continue
    
    print(f"\n{'=' * 100}")
    print(f"  {user} 数据对比")
    print(f"{'=' * 100}")
    
    # 1. by-campaign 数据
    bc_data = api_get(tokens[user], "/api/google-ads-aggregate/by-campaign", {"date_range_type": "past7days", "status": "ENABLED"})
    bc_campaigns = {}
    if bc_data:
        clist = bc_data.get("campaigns") or bc_data.get("data") or []
        if isinstance(bc_data, dict) and "campaigns" not in bc_data and "data" not in bc_data:
            # 可能直接是列表
            clist = bc_data if isinstance(bc_data, list) else []
        for c in clist:
            name = c.get("campaign_name", c.get("name", "?"))
            bc_campaigns[name] = c
    
    # 2. L7D 分析
    print(f"\n  触发 L7D 分析...")
    l7d_data = api_post(tokens[user], "/api/analysis/l7d")
    l7d_campaigns = {}
    if l7d_data:
        # 看看返回结构
        if isinstance(l7d_data, dict):
            results = l7d_data.get("results") or l7d_data.get("data") or l7d_data.get("campaigns") or []
            if not results and "analysis" in l7d_data:
                results = l7d_data["analysis"]
            # 打印结构
            print(f"  L7D 返回 keys: {list(l7d_data.keys())}")
            if isinstance(results, list) and len(results) > 0:
                print(f"  第一条 keys: {list(results[0].keys()) if isinstance(results[0], dict) else type(results[0])}")
                for r in results:
                    if isinstance(r, dict):
                        name = r.get("campaign_name") or r.get("name") or r.get("campaign") or "?"
                        l7d_campaigns[name] = r
            elif isinstance(results, dict):
                print(f"  results keys: {list(results.keys())[:20]}")
        print(f"  L7D 前2000字: {json.dumps(l7d_data, ensure_ascii=False)[:2000]}")
    
    # 3. 对比
    all_names = sorted(set(list(bc_campaigns.keys()) + list(l7d_campaigns.keys())))
    
    if bc_campaigns and l7d_campaigns:
        print(f"\n  {'广告系列':<55} {'BC费用':>8} {'L7D费用':>8} {'差':>6} {'BC_BL':>7} {'L7D_BL':>7} {'BC_RL':>7} {'L7D_RL':>7}")
        print("  " + "-" * 120)
        for name in all_names:
            bc = bc_campaigns.get(name, {})
            l7d = l7d_campaigns.get(name, {})
            bc_cost = bc.get("cost", 0) or 0
            l7d_cost = l7d.get("cost", l7d.get("total_cost", 0)) or 0
            bc_bl = bc.get("is_budget_lost", 0) or 0
            l7d_bl = l7d.get("is_budget_lost", 0) or 0
            bc_rl = bc.get("is_rank_lost", 0) or 0
            l7d_rl = l7d.get("is_rank_lost", 0) or 0
            cost_diff = bc_cost - l7d_cost
            if abs(cost_diff) > 0.01 or abs(bc_bl - l7d_bl) > 0.01 or abs(bc_rl - l7d_rl) > 0.01:
                print(f"  {name[:55]:<55} {bc_cost:>8.2f} {l7d_cost:>8.2f} {cost_diff:>+6.2f} {bc_bl:>7.4f} {l7d_bl:>7.4f} {bc_rl:>7.4f} {l7d_rl:>7.4f}")
    elif bc_campaigns:
        print(f"\n  只有 by-campaign 数据，L7D 无数据")
        print(f"  by-campaign 共 {len(bc_campaigns)} 个广告系列")
    else:
        print(f"\n  两个数据源都没有数据")
