"""Configure Cloudflare DNS - debug token first"""
import httpx, sys, json
sys.stdout.reconfigure(encoding='utf-8')

CF_TOKEN = 'MlysGPG0UizFwaWK52quYpCJZA415HZPo-xg5zas'
headers = {
    'Authorization': f'Bearer {CF_TOKEN}',
    'Content-Type': 'application/json'
}

# Verify token
r = httpx.get('https://api.cloudflare.com/client/v4/user/tokens/verify', headers=headers, timeout=15)
print(f"Status code: {r.status_code}")
print(f"Response: {json.dumps(r.json(), indent=2)}")
