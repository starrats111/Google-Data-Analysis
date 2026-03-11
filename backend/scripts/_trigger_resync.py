import requests, sys, time
sys.stdout.reconfigure(encoding='utf-8')

BASE = "http://47.239.193.33:8000"

# Login as admin
r = requests.post(f"{BASE}/api/auth/login", data={"username": "wj07", "password": "wj123456"})
print(f"Login: {r.status_code}")
if r.status_code != 200:
    print(r.text)
    sys.exit(1)
token = r.json()["access_token"]
headers = {"Authorization": f"Bearer {token}"}

# Trigger full sync
r = requests.post(f"{BASE}/api/article-gen/campaign-link/sync-all", headers=headers)
print(f"Sync trigger: {r.status_code} {r.text}")

# Monitor progress by checking cache counts every 30s
print("\nMonitoring sync progress...")
for i in range(40):
    time.sleep(30)
    try:
        r = requests.get(f"{BASE}/api/article-gen/campaign-link/cache-stats", headers=headers, timeout=10)
        if r.status_code == 200:
            data = r.json()
            print(f"[{(i+1)*30}s] Stats: {data}")
        else:
            print(f"[{(i+1)*30}s] Status check: {r.status_code}")
    except Exception as e:
        print(f"[{(i+1)*30}s] Error: {e}")
