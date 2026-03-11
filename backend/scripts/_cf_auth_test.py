"""Try different auth methods with Cloudflare"""
import httpx, sys, json
sys.stdout.reconfigure(encoding='utf-8')

token = 'MlysGPG0UizFwaWK52quYpCJZA415HZPo-xg5zas'

# Method 1: Bearer token (API Token)
print("=== Method 1: Bearer Token ===")
r = httpx.get('https://api.cloudflare.com/client/v4/user/tokens/verify', 
    headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}, timeout=15)
print(f"  Status: {r.status_code} - {r.json().get('errors', [])}")

# Method 2: X-Auth-Key (Global API Key) - needs email
# We don't have the email, but let's try common patterns
print("\n=== Method 2: Global API Key (need email) ===")
print("  This token might be a Global API Key, which requires an email address.")

# Method 3: Try as API Token with different format
print("\n=== Method 3: Try listing zones ===")
r = httpx.get('https://api.cloudflare.com/client/v4/zones?per_page=5', 
    headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}, timeout=15)
print(f"  Status: {r.status_code}")
errs = r.json().get('errors', [])
if errs:
    print(f"  Errors: {errs}")
else:
    zones = r.json().get('result', [])
    for z in zones:
        print(f"  Zone: {z['name']}")
