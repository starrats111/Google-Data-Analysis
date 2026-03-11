"""Fix ALL site DNS records: add www + set DNS Only (grey cloud) for all domains"""
import httpx, sys, json, time
sys.stdout.reconfigure(encoding='utf-8')

CF_TOKEN = 'MlysGPG0UizFwaWK52quYpCJZA415HZPo-xg5zas'
BT_IP = '52.74.221.116'
headers = {
    'Authorization': f'Bearer {CF_TOKEN}',
    'Content-Type': 'application/json'
}

# Step 1: Get all zones
print("=== Getting all zones ===")
all_zones = []
page = 1
while True:
    r = httpx.get(f'https://api.cloudflare.com/client/v4/zones?per_page=50&page={page}', headers=headers, timeout=20)
    data = r.json()
    zones = data.get('result', [])
    all_zones.extend(zones)
    if len(zones) < 50:
        break
    page += 1

print(f"Found {len(all_zones)} zones total")
for z in all_zones:
    print(f"  {z['name']}")

# Step 2: For each zone, fix DNS
for zone in all_zones:
    domain = zone['name']
    zone_id = zone['id']
    print(f"\n{'='*60}")
    print(f"=== {domain} (zone_id={zone_id}) ===")
    
    # Get all DNS records
    r = httpx.get(f'https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records', headers=headers, timeout=15)
    records = r.json().get('result', [])
    
    print(f"  Current records:")
    for rec in records:
        proxy_icon = "🟠" if rec.get('proxied') else "⚪"
        print(f"    {proxy_icon} {rec['type']:6s} {rec['name']:45s} -> {rec['content']}")
    
    # Find existing records
    root_a = None
    www_a = None
    root_aaaa = None
    www_aaaa = None
    
    for rec in records:
        if rec['name'] == domain:
            if rec['type'] == 'A':
                root_a = rec
            elif rec['type'] == 'AAAA':
                root_aaaa = rec
        elif rec['name'] == f'www.{domain}':
            if rec['type'] == 'A':
                www_a = rec
            elif rec['type'] == 'AAAA':
                www_aaaa = rec
            elif rec['type'] == 'CNAME':
                www_a = rec  # treat CNAME as existing www record
    
    changes_made = False
    
    # Fix 1: Root A record - ensure it points to BT_IP and is DNS Only
    if root_a:
        needs_update = False
        reasons = []
        if root_a['content'] != BT_IP:
            reasons.append(f"IP {root_a['content']} -> {BT_IP}")
            needs_update = True
        if root_a.get('proxied', False):
            reasons.append("proxied -> DNS Only")
            needs_update = True
        
        if needs_update:
            print(f"  Updating root A: {', '.join(reasons)}")
            ur = httpx.put(
                f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{root_a['id']}",
                headers=headers, timeout=15,
                json={'type': 'A', 'name': domain, 'content': BT_IP, 'ttl': 1, 'proxied': False}
            )
            success = ur.json().get('success')
            print(f"    Result: {success}")
            if not success:
                print(f"    Errors: {ur.json().get('errors')}")
            changes_made = True
        else:
            print(f"  Root A OK: {domain} -> {BT_IP} (DNS Only)")
    elif root_aaaa and root_aaaa['content'] == '100::':
        # Workers/Pages managed record - can't modify via API
        print(f"  ⚠️  Root has Workers/Pages AAAA 100:: (read-only, needs manual fix)")
    else:
        # No root A record, create one
        print(f"  Creating root A: {domain} -> {BT_IP} (DNS Only)")
        cr = httpx.post(
            f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records",
            headers=headers, timeout=15,
            json={'type': 'A', 'name': domain, 'content': BT_IP, 'ttl': 1, 'proxied': False}
        )
        success = cr.json().get('success')
        print(f"    Result: {success}")
        if not success:
            print(f"    Errors: {cr.json().get('errors')}")
        changes_made = True
    
    # Fix 2: www A record - ensure it exists, points to BT_IP, DNS Only
    if www_a:
        needs_update = False
        reasons = []
        if www_a['type'] == 'CNAME':
            # Delete CNAME, create A
            print(f"  Deleting www CNAME: {www_a['name']} -> {www_a['content']}")
            httpx.delete(f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{www_a['id']}", headers=headers, timeout=15)
            print(f"  Creating www A: www.{domain} -> {BT_IP} (DNS Only)")
            cr = httpx.post(
                f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records",
                headers=headers, timeout=15,
                json={'type': 'A', 'name': f'www.{domain}', 'content': BT_IP, 'ttl': 1, 'proxied': False}
            )
            print(f"    Result: {cr.json().get('success')}")
            changes_made = True
        else:
            if www_a['content'] != BT_IP:
                reasons.append(f"IP {www_a['content']} -> {BT_IP}")
                needs_update = True
            if www_a.get('proxied', False):
                reasons.append("proxied -> DNS Only")
                needs_update = True
            
            if needs_update:
                print(f"  Updating www A: {', '.join(reasons)}")
                ur = httpx.put(
                    f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{www_a['id']}",
                    headers=headers, timeout=15,
                    json={'type': 'A', 'name': f'www.{domain}', 'content': BT_IP, 'ttl': 1, 'proxied': False}
                )
                success = ur.json().get('success')
                print(f"    Result: {success}")
                if not success:
                    print(f"    Errors: {ur.json().get('errors')}")
                changes_made = True
            else:
                print(f"  www A OK: www.{domain} -> {BT_IP} (DNS Only)")
    else:
        # No www record, create one
        print(f"  Creating www A: www.{domain} -> {BT_IP} (DNS Only)")
        cr = httpx.post(
            f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records",
            headers=headers, timeout=15,
            json={'type': 'A', 'name': f'www.{domain}', 'content': BT_IP, 'ttl': 1, 'proxied': False}
        )
        success = cr.json().get('success')
        print(f"    Result: {success}")
        if not success:
            print(f"    Errors: {cr.json().get('errors')}")
        changes_made = True
    
    if not changes_made:
        print(f"  ✅ No changes needed")
    
    # Small delay to avoid rate limiting
    time.sleep(0.3)

print(f"\n{'='*60}")
print("=== ALL DONE ===")
print(f"All domains should now have @ and www A records -> {BT_IP} (DNS Only / grey cloud)")
