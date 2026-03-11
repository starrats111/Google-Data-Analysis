"""Check and remove Cloudflare Pages custom domains"""
import httpx, sys, json
sys.stdout.reconfigure(encoding='utf-8')

CF_TOKEN = 'MlysGPG0UizFwaWK52quYpCJZA415HZPo-xg5zas'
headers = {
    'Authorization': f'Bearer {CF_TOKEN}',
    'Content-Type': 'application/json'
}

# Get account ID first
print("=== Getting account info ===")
r = httpx.get('https://api.cloudflare.com/client/v4/accounts?per_page=10', headers=headers, timeout=15)
accounts = r.json().get('result', [])
for acc in accounts:
    print(f"  Account: {acc['name']} (id={acc['id']})")

if not accounts:
    print("No accounts found!")
    sys.exit(1)

account_id = accounts[0]['id']

# List Pages projects
print(f"\n=== Pages projects (account: {account_id}) ===")
r = httpx.get(f'https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects?per_page=50', headers=headers, timeout=15)
print(f"  Status: {r.status_code}")
projects = r.json().get('result', [])
print(f"  Found {len(projects)} projects")

for proj in projects:
    name = proj.get('name', '?')
    subdomain = proj.get('subdomain', '?')
    domains = proj.get('domains', [])
    print(f"\n  Project: {name}")
    print(f"    Subdomain: {subdomain}")
    print(f"    Custom domains: {domains}")
    
    # Check if this project has our target domains
    for d in domains:
        if 'viva-luxe-life' in d or 'deliveryandplate' in d:
            print(f"    *** FOUND TARGET DOMAIN: {d} ***")
            print(f"    Removing custom domain {d} from project {name}...")
            
            # Delete custom domain from Pages project
            dr = httpx.delete(
                f'https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects/{name}/domains/{d}',
                headers=headers, timeout=15
            )
            print(f"    Delete result: status={dr.status_code}, success={dr.json().get('success', '?')}")
            if not dr.json().get('success'):
                print(f"    Errors: {dr.json().get('errors')}")
