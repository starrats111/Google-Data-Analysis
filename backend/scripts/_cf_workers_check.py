"""Check Workers custom domains and try to remove them"""
import httpx, sys, json
sys.stdout.reconfigure(encoding='utf-8')

CF_TOKEN = 'MlysGPG0UizFwaWK52quYpCJZA415HZPo-xg5zas'
account_id = '1790721f9b4313e7b33e6dad111892e0'
headers = {
    'Authorization': f'Bearer {CF_TOKEN}',
    'Content-Type': 'application/json'
}

# List Workers
print("=== Workers scripts ===")
r = httpx.get(f'https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts', headers=headers, timeout=15)
print(f"  Status: {r.status_code}")
scripts = r.json().get('result', [])
for s in scripts:
    print(f"  Script: {s.get('id', '?')}")

# List Workers custom domains
print("\n=== Workers custom domains ===")
r = httpx.get(f'https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/domains', headers=headers, timeout=15)
print(f"  Status: {r.status_code}")
if r.status_code == 200:
    domains = r.json().get('result', [])
    for d in domains:
        hostname = d.get('hostname', '?')
        service = d.get('service', '?')
        did = d.get('id', '?')
        print(f"  Domain: {hostname} -> service={service} (id={did})")
        
        if 'viva-luxe-life' in hostname or 'deliveryandplate' in hostname:
            print(f"    *** Removing {hostname} ***")
            dr = httpx.delete(f'https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/domains/{did}', headers=headers, timeout=15)
            print(f"    Result: status={dr.status_code}, success={dr.json().get('success', '?')}")
else:
    print(f"  Response: {r.text[:500]}")

# Also try Pages projects with different endpoint
print("\n=== Trying Pages projects ===")
r = httpx.get(f'https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects', headers=headers, timeout=15)
print(f"  Status: {r.status_code}")
if r.status_code == 200:
    for p in r.json().get('result', []):
        print(f"  Project: {p.get('name')} domains={p.get('domains', [])}")
else:
    # The token might not have Pages permission, let's check what permissions it has
    print(f"  No Pages access. Checking token permissions...")
    r2 = httpx.get('https://api.cloudflare.com/client/v4/user', headers=headers, timeout=15)
    print(f"  User endpoint: {r2.status_code}")
