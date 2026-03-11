"""Delete Workers-managed AAAA records and create A records"""
import httpx, sys, json
sys.stdout.reconfigure(encoding='utf-8')

CF_TOKEN = 'MlysGPG0UizFwaWK52quYpCJZA415HZPo-xg5zas'
BT_IP = '52.74.221.116'
headers = {
    'Authorization': f'Bearer {CF_TOKEN}',
    'Content-Type': 'application/json'
}

domains_zones = {
    'viva-luxe-life.top': '3d0fd114567bb177ca40b7309079cf2a',
    'deliveryandplate.top': 'dbae4f07583bd7ce6d9360fd97170e96',
}

for domain, zone_id in domains_zones.items():
    print(f"\n=== {domain} ===")
    
    # Check Workers routes
    print("  Checking Workers routes...")
    r = httpx.get(f'https://api.cloudflare.com/client/v4/zones/{zone_id}/workers/routes', headers=headers, timeout=15)
    routes = r.json().get('result', [])
    if routes:
        for route in routes:
            print(f"    Route: {route.get('pattern', '?')} -> {route.get('script', '?')} (id={route['id']})")
            # Delete the route
            print(f"    Deleting route...")
            dr = httpx.delete(f"https://api.cloudflare.com/client/v4/zones/{zone_id}/workers/routes/{route['id']}", headers=headers, timeout=15)
            print(f"    Result: {dr.json().get('success')}")
    else:
        print("    No Workers routes found")
    
    # Check Workers custom domains
    print("  Checking Workers custom domains...")
    r = httpx.get(f'https://api.cloudflare.com/client/v4/zones/{zone_id}/workers/domains', headers=headers, timeout=15)
    print(f"    Status: {r.status_code}")
    if r.status_code == 200:
        doms = r.json().get('result', [])
        for d in doms:
            print(f"    Domain: {d}")
    
    # Try to delete the AAAA record
    print("  Getting DNS records...")
    r = httpx.get(f'https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records', headers=headers, timeout=15)
    records = r.json().get('result', [])
    for rec in records:
        print(f"    {rec['type']:6s} {rec['name']:40s} -> {rec['content']:20s} id={rec['id']}")
        if rec['type'] == 'AAAA' and rec['name'] == domain and rec['content'] == '100::':
            print(f"    Deleting Workers AAAA record...")
            dr = httpx.delete(f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{rec['id']}", headers=headers, timeout=15)
            print(f"    Delete result: {dr.json().get('success')}")
            if not dr.json().get('success'):
                print(f"    Errors: {dr.json().get('errors')}")
    
    # Now try creating A record again
    print(f"  Creating A record: {domain} -> {BT_IP}")
    cr = httpx.post(f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records", 
        headers=headers, timeout=15, json={
            'type': 'A', 'name': domain, 'content': BT_IP, 'ttl': 1, 'proxied': False
        })
    print(f"    Result: {cr.json().get('success')}")
    if not cr.json().get('success'):
        print(f"    Errors: {cr.json().get('errors')}")
    
    # Final check
    print(f"\n  Final DNS records:")
    r = httpx.get(f'https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records', headers=headers, timeout=15)
    for rec in r.json().get('result', []):
        print(f"    {rec['type']:6s} {rec['name']:40s} -> {rec['content']}")

print("\n=== Done ===")
