"""查询 wj04/wj05 的 L7D 分析结果和每日明细"""
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
    r = requests.get(f"{BASE}{path}", headers=headers, params=params or {})
    if r.status_code == 200:
        return r.json()
    else:
        print(f"  GET {path} => {r.status_code}: {r.text[:300]}")
        return None

# 登录
tokens = {}
for user, pwd in [("wj04", "wj123456"), ("wj05", "wj123456")]:
    t = login(user, pwd)
    if t:
        tokens[user] = t

# 1. 查看 L7D 分析结果
for user in ["wj04", "wj05"]:
    if user not in tokens:
        continue
    print(f"\n{'=' * 80}")
    print(f"{user} - L7D 分析结果")
    print(f"{'=' * 80}")
    
    # 尝试获取分析结果
    data = api_get(tokens[user], "/api/analysis/l7d")
    if data:
        results = data if isinstance(data, list) else data.get("results") or data.get("data") or [data]
        if isinstance(results, list):
            print(f"  共 {len(results)} 条分析结果")
            for r in results[:5]:
                print(f"  keys: {list(r.keys())[:15]}")
                break
        elif isinstance(results, dict):
            print(f"  keys: {list(results.keys())[:15]}")
        print(f"  前1000字: {json.dumps(data, ensure_ascii=False)[:1000]}")
    
    # 尝试获取报告列表
    print(f"\n  --- 报告列表 ---")
    reports = api_get(tokens[user], "/api/gemini/reports")
    if reports:
        rlist = reports if isinstance(reports, list) else reports.get("reports") or reports.get("data") or []
        if isinstance(rlist, list):
            print(f"  共 {len(rlist)} 份报告")
            for r in rlist[:3]:
                print(f"    ID={r.get('id')}, type={r.get('type')}, created={r.get('created_at','?')[:19]}")
        else:
            print(f"  keys: {list(reports.keys()) if isinstance(reports, dict) else type(reports)}")

# 2. 查看每日原始数据 (by-date)
for user in ["wj04", "wj05"]:
    if user not in tokens:
        continue
    print(f"\n{'=' * 80}")
    print(f"{user} - 每日原始数据")
    print(f"{'=' * 80}")
    
    # 尝试 by-date 端点
    data = api_get(tokens[user], "/api/google-ads-aggregate/by-date", {"date_range_type": "past7days"})
    if data:
        print(f"  by-date keys: {list(data.keys()) if isinstance(data, dict) else type(data)}")
        print(f"  前500字: {json.dumps(data, ensure_ascii=False)[:500]}")
    
    # 尝试 summary 端点
    data = api_get(tokens[user], "/api/google-ads-aggregate/summary", {"date_range_type": "past7days"})
    if data:
        print(f"\n  summary: {json.dumps(data, ensure_ascii=False)[:500]}")
