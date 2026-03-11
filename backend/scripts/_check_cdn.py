import httpx, sys
sys.stdout.reconfigure(encoding='utf-8')

r = httpx.get('https://vitahaven.click/js/articles-index.js', follow_redirects=True, timeout=15)
print(f'Status: {r.status_code}')
print(f'CF-Cache: {r.headers.get("cf-cache-status", "N/A")}')
print(f'Cache-Control: {r.headers.get("cache-control", "N/A")}')
print('---Content---')
print(r.text)
