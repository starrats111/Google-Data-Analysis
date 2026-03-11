"""Verify zontri article is accessible"""
import httpx, sys
sys.stdout.reconfigure(encoding='utf-8')

# Check if articles-index.js contains the article
print("=== Checking articles-index.js ===")
try:
    resp = httpx.get("https://zontri.top/js/articles-index.js", timeout=15, follow_redirects=True)
    print(f"Status: {resp.status_code}")
    if 'quiet-art' in resp.text or 'well-made-shirt' in resp.text:
        print("✓ Article 9 found in articles-index.js!")
    else:
        print("✗ Article 9 NOT found in articles-index.js")
        print("First 500 chars:", resp.text[:500])
except Exception as e:
    print(f"Error: {e}")

# Check if article JSON exists
print("\n=== Checking article JSON ===")
try:
    resp = httpx.get("https://zontri.top/js/articles/9.json", timeout=15, follow_redirects=True)
    print(f"Status: {resp.status_code}")
    if resp.status_code == 200:
        data = resp.json()
        print(f"✓ Article title: {data.get('title')}")
    else:
        print(f"✗ Failed: {resp.text[:200]}")
except Exception as e:
    print(f"Error: {e}")

# Check article page
print("\n=== Checking article page ===")
try:
    resp = httpx.get("https://zontri.top/article.html?title=the-quiet-art-of-a-well-made-shirt", timeout=15, follow_redirects=True)
    print(f"Status: {resp.status_code}")
    if 'Article not found' in resp.text:
        print("✗ Still showing 'Article not found' (but this is expected - it's client-side rendered)")
    else:
        print("Page loaded (client-side JS will handle rendering)")
except Exception as e:
    print(f"Error: {e}")
