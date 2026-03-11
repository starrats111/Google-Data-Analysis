"""Remove Workers custom domains and fix DNS"""
import httpx, sys, json, time
sys.stdout.reconfigure(encoding='utf-8')

CF_TOKEN = 'MlysGPG0UizFwaWK52quYpCJZA415HZPo-xg5zas'
BT_IP = '52.74.221.116'
headers = {
    'Authorization': f'Bearer {CF_TOKEN}',
    'Content-Type': 'application/json'
}

r = httpx.get('https://api.cloudflare.com/client/v4/accounts?per_page=10', headers=headers, timeout=15)
account_id = r.json()['result'][0]['id']

targets = ['viva-luxe-life.top', 'deliveryandplate.top']
zone_map = {
    'viva-luxe-life.top': '3d0fd114567bb177ca40b7309079cf2a',
    'deliveryandplate.top': 'dbae4f07583bd7ce6d9360fd97170e96',
}

# Step 1: List and remove Workers custom domains
print("=== Workers custom domains ===")
r = httpx.get(f'https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/domains', headers=headers, timeout=15)
wdomains = r.json().get('result') or []
print(f"Found {len(wdomains)} Workers domains:")
for wd in wdomains:
    hostname = wd.get('hostname', '?')
    service = wd.get('service', '?')
    wid = wd.get('id', '?')
    print(f"  {hostname} -> {service} (id={wid})")

# Remove all target domains
for wd in wdomains:
    hostname = wd.get('hostname', '?')
    wid = wd.get('id', '?')
    for td in targets:
        if td in hostname:
            print(f"\nRemoving Workers domain: {hostname} (id={wid})...")
            dr = httpx.delete(
                f'https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/domains/{wid}',
                headers=headers, timeout=15
            )
            print(f"  Status: {dr.status_code}")
            if dr.text:
                try:
                    print(f"  Response: {dr.json()}")
                except:
                    print(f"  Raw: {dr.text[:200]}")
            else:
                print(f"  Empty response (likely success)")

# Wait for propagation
print("\nWaiting 5 seconds...")
time.sleep(5)

# Step 2: Verify Workers domains removed
print("\n=== Verifying Workers domains ===")
r = httpx.get(f'https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/domains', headers=headers, timeout=15)
wdomains = r.json().get('result') or []
print(f"Remaining: {len(wdomains)} domains")
for wd in wdomains:
    print(f"  {wd.get('hostname', '?')}")

# Step 3: Fix DNS
print("\n=== Fixing DNS records ===")
for domain in targets:
    zone_id = zone_map[domain]
    print(f"\n--- {domain} ---")
    
    # Get current records
    r = httpx.get(f'https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records', headers=headers, timeout=15)
    records = r.json().get('result', [])
    for rec in records:
        p = "proxied" if rec.get('proxied') else "dns-only"
        print(f"  {rec['type']:6s} {rec['name']:40s} -> {rec['content']:20s} ({p})")
    
    # Delete AAAA 100:: if still exists
    for rec in records:
        if rec['type'] == 'AAAA' and rec['name'] == domain and rec['content'] == '100::':
            print(f"  Deleting AAAA 100::...")
            dr = httpx.delete(f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{rec['id']}", headers=headers, timeout=15)
            try:
                print(f"    success={dr.json().get('success')} errors={dr.json().get('errors')}")
            except:
                print(f"    status={dr.status_code}")
    
    time.sleep(1)
    
    # Create A record if needed
    r2 = httpx.get(f'https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records?type=A&name={domain}', headers=headers, timeout=15)
    existing = r2.json().get('result', [])
    if not existing:
        print(f"  Creating A: {domain} -> {BT_IP} (DNS Only)")
        cr = httpx.post(f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records",
            headers=headers, timeout=15,
            json={'type': 'A', 'name': domain, 'content': BT_IP, 'ttl': 1, 'proxied': False})
        print(f"    success={cr.json().get('success')} errors={cr.json().get('errors')}")
    else:
        a = existing[0]
        if a['content'] != BT_IP or a.get('proxied'):
            print(f"  Updating A: -> {BT_IP} (DNS Only)")
            httpx.put(f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{a['id']}",
                headers=headers, timeout=15,
                json={'type': 'A', 'name': domain, 'content': BT_IP, 'ttl': 1, 'proxied': False})
        else:
            print(f"  A record OK")

# Final
print("\n=== Final state ===")
for domain in targets:
    zone_id = zone_map[domain]
    r = httpx.get(f'https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records', headers=headers, timeout=15)
    print(f"\n{domain}:")
    for rec in r.json().get('result', []):
        p = "proxied" if rec.get('proxied') else "dns-only"
        print(f"  {rec['type']:6s} {rec['name']:40s} -> {rec['content']:20s} ({p})")

print("\nDone!")
