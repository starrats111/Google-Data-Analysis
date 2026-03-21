"""Check DNS records for all publish site domains"""
import json
import urllib.request

CF_TOKEN = "MlysGPG0UizFwaWK52quYpCJZA415HZPo-xg5zas"
BT_IP = "52.74.221.116"

ZONES = {
    "allurahub.top": "fdec04da5e2991cdf48d6edd25d27a4a",
    "aura-bloom.top": "af6745d3cad66d98e3c58788218875b1",
    "aurislane.top": "f6255af96938da3dedc742ca236dd49d",
    "bloomroots.top": "e443a92116085ec337c7f7271da1429f",
    "deliveryandplate.top": "dbae4f07583bd7ce6d9360fd97170e96",
    "everydayhaven.top": "a54b8b2c4b4cf0ceebdc6b8c148d928b",
    "everydaynes.top": "9bbb73eb09dfd2a6b161d62f698f1ebf",
    "keymint.co": "f08fc7c961e7b7013a3a2ae0eb5441db",
    "kivanta.top": "7a4b4eaaff1057aac345e59abbb79eea",
    "mevora.top": "46cbd900dcfbe9d84664b6338d79f0c7",
    "novanest.one": "67ac5e8c585ebabb326a047fae075afb",
    "quiblo.top": "1cd040fbb0c5e79c27b573c3ecfc9faf",
    "vitahaven.click": "ad912403e6fb4bbc9044d326fcdca5f0",
    "vitasphere.top": "ac7ddcf90f876473eeb6cc10fb5afc1d",
    "zontri.top": "cf4ade51249e740bf33dc04dce387182",
    "viva-luxe-life.top": "3d0fd114567bb177ca40b7309079cf2a",
}

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

broken = []
for domain, zone_id in ZONES.items():
    r = cf_api(f"/zones/{zone_id}/dns_records")
    if r.get("success"):
        records = r["result"]
        root_records = [rec for rec in records if rec["name"] == domain]
        has_pages_ref = any("pages.dev" in rec.get("content", "") for rec in records)
        
        print(f"\n{domain}:")
        for rec in records:
            indicator = " *** BROKEN ***" if "pages.dev" in rec.get("content", "") else ""
            print(f"  {rec['type']:6s} {rec['name']:35s} -> {rec['content']:30s} proxied={rec.get('proxied')}{indicator}")
        
        if has_pages_ref:
            broken.append(domain)
    else:
        print(f"\n{domain}: ERROR - {r.get('errors')}")

print(f"\n\n=== Summary ===")
print(f"Total domains checked: {len(ZONES)}")
print(f"Domains with broken pages.dev references: {len(broken)}")
for d in broken:
    print(f"  - {d}")
