"""精确对比三个数据源的差异"""
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

tokens = {}
for user, pwd in [("wj04", "wj123456"), ("wj05", "wj123456")]:
    t = login(user, pwd)
    if t:
        tokens[user] = t

for user in ["wj04", "wj05"]:
    if user not in tokens:
        continue
    
    # 1. by-campaign (2/21-2/27)
    bc = api_get(tokens[user], "/api/google-ads-aggregate/by-campaign", {
        "date_range_type": "past7days", "status": "ENABLED"
    })
    bc_map = {}
    if bc:
        for c in bc.get("campaigns", []):
            bc_map[c["campaign_name"]] = c
    
    # 2. l7d-data (2/21-2/27, 同期)
    l7d_same = api_get(tokens[user], "/api/gemini/l7d-data", {
        "start_date": "2026-02-21", "end_date": "2026-02-27"
    })
    l7d_map = {}
    if l7d_same:
        for c in l7d_same.get("campaigns", []):
            l7d_map[c["campaign_name"]] = c
    
    # 3. l7d-data (2/19-2/25, 标准L7D)
    l7d_std = api_get(tokens[user], "/api/gemini/l7d-data", {
        "start_date": "2026-02-19", "end_date": "2026-02-25"
    })
    l7d_std_map = {}
    if l7d_std:
        for c in l7d_std.get("campaigns", []):
            l7d_std_map[c["campaign_name"]] = c
    
    print(f"\n{'=' * 140}")
    print(f"  {user} - 三数据源对比 (只显示有差异的广告系列)")
    print(f"{'=' * 140}")
    print(f"  BC = by-campaign API (2/21-2/27, IS取最后一天)")
    print(f"  L7 = l7d-data (2/21-2/27, IS取max)")
    print(f"  ST = l7d-data (2/19-2/25, IS取max, 标准L7D)")
    
    all_names = sorted(set(list(bc_map.keys()) + list(l7d_map.keys()) + list(l7d_std_map.keys())))
    
    print(f"\n  {'广告系列':<50} {'BC费用':>7} {'L7费用':>7} {'ST费用':>7} | {'BC_BL':>6} {'L7_BL':>6} {'ST_BL':>6} | {'BC_RL':>6} {'L7_RL':>6} {'ST_RL':>6}")
    print("  " + "-" * 130)
    
    diff_count = 0
    for name in all_names:
        bc_c = bc_map.get(name, {})
        l7_c = l7d_map.get(name, {})
        st_c = l7d_std_map.get(name, {})
        
        bc_cost = bc_c.get("cost", 0) or 0
        l7_cost = l7_c.get("cost", 0) or 0
        st_cost = st_c.get("cost", 0) or 0
        
        bc_bl = bc_c.get("is_budget_lost", 0) or 0
        l7_bl = l7_c.get("is_budget_lost", 0) or 0
        st_bl = st_c.get("is_budget_lost", 0) or 0
        
        bc_rl = bc_c.get("is_rank_lost", 0) or 0
        l7_rl = l7_c.get("is_rank_lost", 0) or 0
        st_rl = st_c.get("is_rank_lost", 0) or 0
        
        # 检查是否有差异
        cost_diff = abs(bc_cost - l7_cost) > 0.5 or abs(bc_cost - st_cost) > 0.5
        bl_diff = abs(bc_bl - l7_bl) > 0.02 or abs(bc_bl - st_bl) > 0.02
        rl_diff = abs(bc_rl - l7_rl) > 0.02 or abs(bc_rl - st_rl) > 0.02
        
        if cost_diff or bl_diff or rl_diff:
            diff_count += 1
            flags = []
            if cost_diff: flags.append("费用")
            if bl_diff: flags.append("IS_BL")
            if rl_diff: flags.append("IS_RL")
            
            print(f"  {name[:50]:<50} {bc_cost:>7.2f} {l7_cost:>7.2f} {st_cost:>7.2f} | {bc_bl:>6.4f} {l7_bl:>6.4f} {st_bl:>6.4f} | {bc_rl:>6.4f} {l7_rl:>6.4f} {st_rl:>6.4f}  [{','.join(flags)}]")
    
    print(f"\n  共 {diff_count} 个广告系列有差异 (总共 {len(all_names)} 个)")
    
    # 汇总差异
    bc_total_cost = sum(c.get("cost", 0) or 0 for c in bc_map.values())
    l7_total_cost = sum(c.get("cost", 0) or 0 for c in l7d_map.values())
    st_total_cost = sum(c.get("cost", 0) or 0 for c in l7d_std_map.values())
    print(f"\n  总费用: BC={bc_total_cost:.2f}, L7(同期)={l7_total_cost:.2f}, ST(标准L7D)={st_total_cost:.2f}")
