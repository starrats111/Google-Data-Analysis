"""Verify bloomroots article page works"""
import httpx, sys
sys.stdout.reconfigure(encoding='utf-8')

# Check article page
url = "https://bloomroots.top/article.html?title=no-palm-oil-or-soy-choosing-purer-organic-nutrition-for-your-baby"
print(f"Fetching: {url}")
resp = httpx.get(url, follow_redirects=True, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
print(f"Status: {resp.status_code}")
html = resp.text

# Check script order in returned HTML
import re
scripts = re.findall(r'<script[^>]*src="([^"]*)"[^>]*>', html)
print(f"Script order: {scripts}")

# Check if article.html has the right structure
if 'articleContent' in html:
    print("✅ articleContent div found")
if 'script.js' in html and 'articles-index.js' in html:
    script_pos = html.index('script.js')
    index_pos = html.index('articles-index.js')
    if script_pos < index_pos:
        print("✅ Correct order: script.js BEFORE articles-index.js")
    else:
        print("❌ Wrong order: articles-index.js still before script.js")

# Check articles-index.js
print("\n--- articles-index.js ---")
resp2 = httpx.get("https://bloomroots.top/js/articles-index.js", follow_redirects=True, timeout=15, 
                   headers={"User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache"})
print(f"Status: {resp2.status_code}")
print(resp2.text[:200])

# Check 7.json
print("\n--- 7.json ---")
resp3 = httpx.get("https://bloomroots.top/js/articles/7.json", follow_redirects=True, timeout=15,
                   headers={"User-Agent": "Mozilla/5.0"})
print(f"Status: {resp3.status_code}")
if resp3.status_code == 200:
    import json
    data = resp3.json()
    print(f"Title: {data.get('title')}")
    content = data.get('content', '')
    print(f"Content type: {type(content).__name__}, length: {len(content)}")
    print(f"Content preview: {content[:200]}...")
