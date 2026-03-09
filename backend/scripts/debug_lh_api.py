"""
调试 LH merchantBasicList3 API 为什么返回 0 条商家
"""
import sys
sys.path.insert(0, '/home/admin/Google-Data-Analysis/backend')

import requests
import json
from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform

db = SessionLocal()

lh_platform = db.query(AffiliatePlatform).filter(AffiliatePlatform.platform_code == "lh").first()
lh_accounts = db.query(AffiliateAccount).filter(AffiliateAccount.platform_id == lh_platform.id).all()

# Pick first account with token
for account in lh_accounts:
    token = None
    if account.notes:
        try:
            notes_data = json.loads(account.notes)
            token = notes_data.get("linkhaitao_token") or notes_data.get("api_token") or notes_data.get("token")
        except:
            pass
    if not token:
        continue

    user = db.query(User).filter(User.id == account.user_id).first()
    print(f"Account: {account.account_name} (User: {user.username if user else 'N/A'})")
    print(f"Token: {token[:10]}...{token[-5:]}")

    # Test merchantBasicList3 with different params
    api_url = "https://www.linkhaitao.com/api.php?mod=medium&op=merchantBasicList3"

    # Test 1: POST with form data (current code uses this)
    print("\n--- Test 1: POST form data ---")
    params = {"token": token, "relationship": "joined", "page": 1, "per_page": 100}
    resp = requests.post(api_url, data=params, timeout=30)
    print(f"Status: {resp.status_code}")
    data = resp.json()
    print(f"Response keys: {list(data.keys()) if isinstance(data, dict) else type(data)}")
    if isinstance(data, dict):
        for k, v in data.items():
            if isinstance(v, list):
                print(f"  {k}: list of {len(v)} items")
            elif isinstance(v, dict):
                print(f"  {k}: dict with keys {list(v.keys())[:5]}")
                for k2, v2 in v.items():
                    if isinstance(v2, list):
                        print(f"    {k2}: list of {len(v2)} items")
            else:
                print(f"  {k}: {v}")

    # Test 2: GET with query params
    print("\n--- Test 2: GET query params ---")
    resp2 = requests.get(api_url, params=params, timeout=30)
    print(f"Status: {resp2.status_code}")
    data2 = resp2.json()
    print(f"Response keys: {list(data2.keys()) if isinstance(data2, dict) else type(data2)}")
    if isinstance(data2, dict):
        for k, v in data2.items():
            if isinstance(v, list):
                print(f"  {k}: list of {len(v)} items")
            elif isinstance(v, dict):
                print(f"  {k}: dict with keys {list(v.keys())[:5]}")
                for k2, v2 in v.items():
                    if isinstance(v2, list):
                        print(f"    {k2}: list of {len(v2)} items")
            else:
                print(f"  {k}: {v}")

    # Test 3: POST with different relationship values
    print("\n--- Test 3: All relationships ---")
    for rel in ["joined", "notjoined", "applying", ""]:
        params3 = {"token": token, "page": 1, "per_page": 10}
        if rel:
            params3["relationship"] = rel
        resp3 = requests.post(api_url, data=params3, timeout=30)
        data3 = resp3.json()
        items = data3.get("data", [])
        if isinstance(items, dict):
            items = items.get("list", items.get("data", []))
        count = len(items) if isinstance(items, list) else 0
        print(f"  relationship='{rel}': {count} items, raw type={type(data3.get('data'))}")

    # Test 4: Print raw response for joined
    print("\n--- Test 4: Raw response (first 2000 chars) ---")
    params4 = {"token": token, "relationship": "joined", "page": 1, "per_page": 5}
    resp4 = requests.post(api_url, data=params4, timeout=30)
    print(resp4.text[:2000])

    break

db.close()
