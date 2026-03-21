"""List all Cloudflare zones in the account"""
import json
import urllib.request

CF_TOKEN = "MlysGPG0UizFwaWK52quYpCJZA415HZPo-xg5zas"

def cf_api(path):
    url = f"https://api.cloudflare.com/client/v4{path}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {CF_TOKEN}",
        "Content-Type": "application/json"
    })
    try:
        resp = urllib.request.urlopen(req)
        return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())

print("=== All Zones ===")
r = cf_api("/zones?per_page=50")
if r.get("success"):
    for z in r["result"]:
        print(f"  {z['name']:30s}  status={z['status']:10s}  ID={z['id']}")
else:
    print(f"  Error: {r.get('errors')}")

print(f"\n  Total: {r.get('result_info', {}).get('total_count', 'N/A')}")
