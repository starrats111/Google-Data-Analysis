"""通过服务器API查询 wj04/wj05 的数据差异"""
import requests
import json

BASE = "https://api.google-data-analysis.top"

def login(username, password):
    r = requests.post(f"{BASE}/api/auth/login", data={"username": username, "password": password})
    if r.status_code == 200:
        data = r.json()
        return data.get("access_token") or data.get("token")
    return None

def get_by_campaign(token, date_range_type="past7days"):
    headers = {"Authorization": f"Bearer {token}"}
    params = {"date_range_type": date_range_type, "status": "ENABLED"}
    r = requests.get(f"{BASE}/api/google-ads-aggregate/by-campaign", headers=headers, params=params)
    if r.status_code == 200:
        return r.json()
    else:
        print(f"  by-campaign 失败: {r.status_code} {r.text[:300]}")
        return None

def get_raw_daily(token, date_range_type="past7days"):
    """获取每日原始数据"""
    headers = {"Authorization": f"Bearer {token}"}
    params = {"date_range_type": date_range_type, "status": "ENABLED"}
    r = requests.get(f"{BASE}/api/google-ads-aggregate/daily", headers=headers, params=params)
    if r.status_code == 200:
        return r.json()
    else:
        print(f"  daily 失败: {r.status_code}")
        return None

# 登录 wj04 和 wj05
print("=" * 80)
print("登录")
print("=" * 80)
tokens = {}
for user, pwd in [("wj04", "wj123456"), ("wj05", "wj123456"), ("manager", "m123456")]:
    t = login(user, pwd)
    if t:
        tokens[user] = t
        print(f"  {user}: OK")
    else:
        print(f"  {user}: FAILED")

# 获取 wj04 的 by-campaign 数据
for user in ["wj04", "wj05"]:
    if user not in tokens:
        continue
    print(f"\n{'=' * 80}")
    print(f"{user} - by-campaign (past7days)")
    print(f"{'=' * 80}")
    data = get_by_campaign(tokens[user])
    if data:
        campaigns = data.get("campaigns") or data.get("data") or data
        if isinstance(campaigns, dict):
            campaigns = campaigns.get("campaigns", [])
        if isinstance(campaigns, list):
            print(f"  共 {len(campaigns)} 个广告系列")
            print(f"  {'广告系列':<55} {'费用':>9} {'展示':>7} {'点击':>5} {'CPC':>6} {'IS_BL':>7} {'IS_RL':>7}")
            print("  " + "-" * 100)
            for c in sorted(campaigns, key=lambda x: -(x.get("cost", 0) or 0)):
                name = c.get("campaign_name", c.get("name", "?"))[:55]
                cost = c.get("cost", 0) or 0
                imp = c.get("impressions", 0) or 0
                clicks = c.get("clicks", 0) or 0
                cpc = c.get("cpc", 0) or 0
                is_bl = c.get("is_budget_lost", 0) or 0
                is_rl = c.get("is_rank_lost", 0) or 0
                print(f"  {name:<55} {cost:>9.2f} {imp:>7} {clicks:>5} {cpc:>6.3f} {is_bl:>7.4f} {is_rl:>7.4f}")
        else:
            print(f"  响应格式: {type(campaigns)}")
            print(f"  keys: {data.keys() if isinstance(data, dict) else 'N/A'}")
            print(f"  前500字: {json.dumps(data, ensure_ascii=False)[:500]}")
    else:
        print("  无数据")
