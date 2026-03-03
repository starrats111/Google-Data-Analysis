"""分析 wj04/wj05 数据差异的根因 - 对比 by-campaign 和 L7D 的 IS 计算"""
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

# 获取 by-campaign 数据
for user in ["wj04", "wj05"]:
    if user not in tokens:
        continue
    
    print(f"\n{'=' * 120}")
    print(f"  {user} 数据差异分析")
    print(f"{'=' * 120}")
    
    bc = api_get(tokens[user], "/api/google-ads-aggregate/by-campaign", {
        "date_range_type": "past7days", "status": "ENABLED"
    })
    if not bc:
        continue
    
    campaigns = bc.get("campaigns", [])
    begin_date = bc.get("begin_date", "?")
    end_date = bc.get("end_date", "?")
    print(f"  日期范围: {begin_date} ~ {end_date}")
    print(f"  共 {len(campaigns)} 个广告系列")
    
    # 分析每个广告系列
    print(f"\n  === IS 差异分析 ===")
    print(f"  by-campaign API 的 IS 取的是日期范围内最后一天的值（非加权平均）")
    print(f"  L7D 分析（已修复但未部署）使用 impressions 加权平均")
    print(f"  当前服务器上的 L7D 分析仍然使用 max() 取最大值")
    
    print(f"\n  有 IS 数据的广告系列:")
    print(f"  {'广告系列':<55} {'费用':>8} {'IS_BL':>8} {'IS_RL':>8} {'货币':>5}")
    print("  " + "-" * 90)
    
    has_is = []
    for c in sorted(campaigns, key=lambda x: -(x.get("cost", 0) or 0)):
        is_bl = c.get("is_budget_lost", 0) or 0
        is_rl = c.get("is_rank_lost", 0) or 0
        if is_bl > 0 or is_rl > 0:
            name = c.get("campaign_name", "?")[:55]
            cost = c.get("cost", 0) or 0
            currency = c.get("currency", "USD")
            print(f"  {name:<55} {cost:>8.2f} {is_bl:>8.4f} {is_rl:>8.4f} {currency:>5}")
            has_is.append(c)
    
    # 分析差异来源
    print(f"\n  === 差异来源总结 ===")
    print(f"  1. IS 计算方式不同:")
    print(f"     - by-campaign (Google Ads后台): 取日期范围内最后一天的 IS 值")
    print(f"     - L7D 分析 (当前服务器): 取7天中 IS 的 max() 最大值")
    print(f"     - L7D 分析 (已修复未部署): 用 impressions 加权平均")
    print(f"     => 三种方式对同一广告系列会产生不同的 IS 值")
    
    # 检查货币
    currencies = set(c.get("currency", "USD") for c in campaigns)
    if len(currencies) > 1:
        print(f"\n  2. 货币混合问题:")
        print(f"     该用户有多种货币: {currencies}")
        for c in campaigns:
            if c.get("currency") != "USD":
                print(f"     {c.get('campaign_name','?')}: {c.get('currency')} (费用已转换为USD)")
    
    # 检查双0广告
    zero_campaigns = [c for c in campaigns if (c.get("cost", 0) or 0) == 0 and (c.get("impressions", 0) or 0) == 0]
    if zero_campaigns:
        print(f"\n  3. 双0广告系列 ({len(zero_campaigns)} 个):")
        for c in zero_campaigns:
            name = c.get("campaign_name", "?")
            is_bl = c.get("is_budget_lost", 0) or 0
            is_rl = c.get("is_rank_lost", 0) or 0
            if is_bl > 0 or is_rl > 0:
                print(f"     {name}: IS_BL={is_bl:.4f}, IS_RL={is_rl:.4f} (有IS但无花费/展示)")
