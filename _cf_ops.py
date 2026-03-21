"""Cloudflare operations: query zones, pages projects, DNS records"""
import json
import sys
import urllib.request

CF_TOKEN = "MlysGPG0UizFwaWK52quYpCJZA415HZPo-xg5zas"
DOMAIN = "google-data-analysis.top"
SERVER_IP = "47.239.193.33"

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


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "info"

    if action == "info":
        print("=== 1. Zones ===")
        r = cf_api("GET", f"/zones?name={DOMAIN}")
        if r.get("success") and r["result"]:
            zone = r["result"][0]
            print(f"  Zone ID: {zone['id']}")
            print(f"  Name: {zone['name']}")
            print(f"  Status: {zone['status']}")
            print(f"  NS: {zone.get('name_servers', [])}")
        else:
            print(f"  No zone found for {DOMAIN}")
            print(f"  Response: {json.dumps(r, indent=2)}")

        print("\n=== 2. Accounts ===")
        r = cf_api("GET", "/accounts")
        if r.get("success") and r["result"]:
            for acc in r["result"]:
                print(f"  Account: {acc['name']} (ID: {acc['id']})")
        else:
            print(f"  Response: {json.dumps(r, indent=2)}")

        print("\n=== 3. Pages Projects ===")
        if r.get("success") and r["result"]:
            acc_id = r["result"][0]["id"]
            pr = cf_api("GET", f"/accounts/{acc_id}/pages/projects")
            if pr.get("success") and pr["result"]:
                for p in pr["result"]:
                    print(f"  Project: {p['name']}")
                    print(f"    Subdomain: {p.get('subdomain', 'N/A')}")
                    print(f"    Domains: {p.get('domains', [])}")
                    prod = p.get("canonical_deployment", {})
                    print(f"    Latest deploy: {prod.get('created_on', 'N/A')}")
            else:
                print(f"  No Pages projects found")
                print(f"  Response: {json.dumps(pr, indent=2)}")

    elif action == "dns_list":
        r = cf_api("GET", f"/zones?name={DOMAIN}")
        zone_id = r["result"][0]["id"]
        dns = cf_api("GET", f"/zones/{zone_id}/dns_records")
        if dns.get("success"):
            for rec in dns["result"]:
                print(f"  {rec['type']:6s} {rec['name']:40s} -> {rec['content']:20s} (proxied={rec.get('proxied')}, id={rec['id']})")
        else:
            print(json.dumps(dns, indent=2))

    elif action == "add_root_dns":
        r = cf_api("GET", f"/zones?name={DOMAIN}")
        zone_id = r["result"][0]["id"]
        
        existing = cf_api("GET", f"/zones/{zone_id}/dns_records?type=A&name={DOMAIN}")
        if existing.get("success") and existing["result"]:
            for rec in existing["result"]:
                print(f"  Updating existing A record {rec['id']}...")
                ur = cf_api("PUT", f"/zones/{zone_id}/dns_records/{rec['id']}", {
                    "type": "A", "name": "@", "content": SERVER_IP, "ttl": 1, "proxied": False
                })
                print(f"  Result: {ur.get('success')}")
        else:
            print(f"  Creating A record: {DOMAIN} -> {SERVER_IP}")
            cr = cf_api("POST", f"/zones/{zone_id}/dns_records", {
                "type": "A", "name": "@", "content": SERVER_IP, "ttl": 1, "proxied": False
            })
            print(f"  Result: {cr.get('success')}")
            if not cr.get("success"):
                print(f"  Errors: {cr.get('errors')}")

    elif action == "delete_pages":
        r = cf_api("GET", "/accounts")
        acc_id = r["result"][0]["id"]
        pr = cf_api("GET", f"/accounts/{acc_id}/pages/projects")
        if pr.get("success") and pr["result"]:
            for p in pr["result"]:
                print(f"  Deleting Pages project: {p['name']}...")
                dr = cf_api("DELETE", f"/accounts/{acc_id}/pages/projects/{p['name']}")
                print(f"  Result: {dr.get('success')}")
                if not dr.get("success"):
                    print(f"  Errors: {dr.get('errors')}")
        else:
            print("  No Pages projects to delete")

    elif action == "add_www_dns":
        r = cf_api("GET", f"/zones?name={DOMAIN}")
        zone_id = r["result"][0]["id"]
        
        existing = cf_api("GET", f"/zones/{zone_id}/dns_records?type=CNAME&name=www.{DOMAIN}")
        if existing.get("success") and existing["result"]:
            for rec in existing["result"]:
                print(f"  Updating existing CNAME record {rec['id']}...")
                ur = cf_api("PUT", f"/zones/{zone_id}/dns_records/{rec['id']}", {
                    "type": "CNAME", "name": "www", "content": DOMAIN, "ttl": 1, "proxied": False
                })
                print(f"  Result: {ur.get('success')}")
        else:
            print(f"  Creating CNAME: www.{DOMAIN} -> {DOMAIN}")
            cr = cf_api("POST", f"/zones/{zone_id}/dns_records", {
                "type": "CNAME", "name": "www", "content": DOMAIN, "ttl": 1, "proxied": False
            })
            print(f"  Result: {cr.get('success')}")

    else:
        print(f"Unknown action: {action}")
        print("Usage: python _cf_ops.py [info|dns_list|add_root_dns|add_www_dns|delete_pages]")


if __name__ == "__main__":
    main()
