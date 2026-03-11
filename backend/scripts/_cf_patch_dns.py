"""Try alternative approaches for root domain DNS"""
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
    
    # Try to update the existing AAAA record to an A record
    r = httpx.get(f'https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records', headers=headers, timeout=15)
    records = r.json().get('result', [])
    
    aaaa_rec = None
    for rec in records:
        if rec['type'] == 'AAAA' and rec['name'] == domain:
            aaaa_rec = rec
            break
    
    if aaaa_rec:
        print(f"  Found AAAA: {aaaa_rec['id']} -> {aaaa_rec['content']}")
        
        # Try PATCH instead of PUT
        print("  Trying PATCH to change type...")
        pr = httpx.patch(f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{aaaa_rec['id']}", 
            headers=headers, timeout=15, json={
                'type': 'A', 'content': BT_IP, 'proxied': False
            })
        print(f"    PATCH result: {pr.status_code} {pr.json().get('success')} {pr.json().get('errors', [])}")
        
        if not pr.json().get('success'):
            # Try overwrite with PUT
            print("  Trying PUT overwrite...")
            pr2 = httpx.put(f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{aaaa_rec['id']}", 
                headers=headers, timeout=15, json={
                    'type': 'A', 'name': domain, 'content': BT_IP, 'ttl': 1, 'proxied': False
                })
            print(f"    PUT result: {pr2.status_code} {pr2.json().get('success')} {pr2.json().get('errors', [])}")

    # Final state
    print(f"\n  Final records:")
    r = httpx.get(f'https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records', headers=headers, timeout=15)
    for rec in r.json().get('result', []):
        print(f"    {rec['type']:6s} {rec['name']:40s} -> {rec['content']}")

print("\n=== Done ===")
