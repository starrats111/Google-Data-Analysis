"""Fix DNS: delete CNAME for root domain, add A record pointing to server"""
import json
import urllib.request

CF_TOKEN = "MlysGPG0UizFwaWK52quYpCJZA415HZPo-xg5zas"
DOMAIN = "google-data-analysis.top"
SERVER_IP = "47.239.193.33"
ZONE_ID = "fd15bb4954d2ba34b64578f4eba45c60"

def cf_api(method, path, data=None):
    url = f"https://api.cloudflare.com/client/v4{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", f"Bearer {CF_TOKEN}")
    req.add_header("Content-Type", "application/json")
    try:
        resp = urllib.request.urlopen(req)
        return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())

# Step 1: Delete existing CNAME record for root domain
print("Step 1: Delete CNAME record for root domain...")
cname_id = "ab2687b51ac5e1e7f5a7200db805c2b5"
r = cf_api("DELETE", f"/zones/{ZONE_ID}/dns_records/{cname_id}")
print(f"  Delete CNAME result: {r.get('success')}")
if not r.get("success"):
    print(f"  Errors: {r.get('errors')}")

# Step 2: Create A record for root domain -> server IP (proxied for free SSL)
print(f"\nStep 2: Create A record: {DOMAIN} -> {SERVER_IP} (proxied)...")
r = cf_api("POST", f"/zones/{ZONE_ID}/dns_records", {
    "type": "A",
    "name": "@",
    "content": SERVER_IP,
    "ttl": 1,
    "proxied": True
})
print(f"  Create A record result: {r.get('success')}")
if not r.get("success"):
    print(f"  Errors: {r.get('errors')}")
else:
    print(f"  Record ID: {r['result']['id']}")

# Step 3: Verify
print(f"\nStep 3: Verify DNS records...")
dns = cf_api("GET", f"/zones/{ZONE_ID}/dns_records")
if dns.get("success"):
    for rec in dns["result"]:
        print(f"  {rec['type']:6s} {rec['name']:40s} -> {rec['content']:20s} (proxied={rec.get('proxied')})")
