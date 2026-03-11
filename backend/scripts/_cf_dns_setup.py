"""Configure Cloudflare DNS for viva-luxe-life.top and deliveryandplate.top"""
import httpx, sys, json
sys.stdout.reconfigure(encoding='utf-8')

CF_TOKEN = 'MlysGPG0UizFwaWK52quYpCJZA415HZPo-xg5zas'
BT_IP = '52.74.221.116'
DOMAINS = ['viva-luxe-life.top', 'deliveryandplate.top']

headers = {
    'Authorization': f'Bearer {CF_TOKEN}',
    'Content-Type': 'application/json'
}

# List all zones
r = httpx.get('https://api.cloudflare.com/client/v4/zones?per_page=50', headers=headers, timeout=15)
zones = r.json().get('result', [])
print(f"Found {len(zones)} zones")

for domain in DOMAINS:
    print(f"\n{'='*50}")
    print(f"=== {domain} ===")
    
    # Find zone
    zone_id = None
    for z in zones:
        if z['name'] == domain:
            zone_id = z['id']
            break
    
    if not zone_id:
        r2 = httpx.get(f'https://api.cloudflare.com/client/v4/zones?name={domain}', headers=headers, timeout=15)
        results = r2.json().get('result', [])
        if results:
            zone_id = results[0]['id']
        else:
            print(f"  ERROR: Zone not found!")
            continue
    
    print(f"  Zone ID: {zone_id}")
    
    # List existing DNS records
    r = httpx.get(f'https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records', headers=headers, timeout=15)
    records = r.json().get('result', [])
    print(f"  Current records ({len(records)}):")
    for rec in records:
        proxied = rec.get('proxied', False)
        print(f"    {rec['type']:6s} {rec['name']:40s} -> {rec['content']:30s} proxied={proxied}")
    
    # Process root domain (@)
    for target_name in [domain, f'www.{domain}']:
        existing = [r for r in records if r['name'] == target_name]
        
        # Delete any CNAME records for this name
        for rec in existing:
            if rec['type'] == 'CNAME':
                print(f"  Deleting CNAME: {rec['name']} -> {rec['content']}")
                dr = httpx.delete(f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{rec['id']}", headers=headers, timeout=15)
                print(f"    Delete result: {dr.json().get('success')}")
        
        # Check if A record exists and needs update
        a_records = [r for r in existing if r['type'] == 'A']
        if a_records:
            rec = a_records[0]
            if rec['content'] != BT_IP or rec.get('proxied', False):
                print(f"  Updating A: {rec['name']} {rec['content']} -> {BT_IP} (DNS Only)")
                ur = httpx.put(f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{rec['id']}", 
                    headers=headers, timeout=15, json={
                        'type': 'A', 'name': target_name, 'content': BT_IP, 'ttl': 1, 'proxied': False
                    })
                print(f"    Update result: {ur.json().get('success')}")
                if not ur.json().get('success'):
                    print(f"    Errors: {ur.json().get('errors')}")
            else:
                print(f"  A record OK: {target_name} -> {BT_IP}")
        else:
            # Create new A record
            print(f"  Creating A: {target_name} -> {BT_IP} (DNS Only)")
            cr = httpx.post(f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records", 
                headers=headers, timeout=15, json={
                    'type': 'A', 'name': target_name, 'content': BT_IP, 'ttl': 1, 'proxied': False
                })
            print(f"    Create result: {cr.json().get('success')}")
            if not cr.json().get('success'):
                print(f"    Errors: {cr.json().get('errors')}")
    
    # Verify final state
    print(f"\n  --- Final DNS records ---")
    r = httpx.get(f'https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records', headers=headers, timeout=15)
    for rec in r.json().get('result', []):
        proxied = rec.get('proxied', False)
        print(f"    {rec['type']:6s} {rec['name']:40s} -> {rec['content']:30s} proxied={proxied}")

print(f"\n=== Done! DNS pointing to {BT_IP} ===")
print("Wait 2-5 minutes for propagation, then apply Let's Encrypt SSL in Baota.")
