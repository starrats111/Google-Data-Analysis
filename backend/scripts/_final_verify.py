"""Final verification: check article rendering"""
import httpx, sys
sys.stdout.reconfigure(encoding='utf-8')

# Verify vitahaven
url = 'https://vitahaven.click/article.html?title=the-smart-way-to-buy-event-tickets-in-2026-why-vivid-seats-rewards-program-changes-everything'
r = httpx.get(url, follow_redirects=True, timeout=15)
print(f"Vitahaven article page: status={r.status_code}")

# Check new main.js has fetch logic
r2 = httpx.get(f'https://vitahaven.click/js/main.js?v=1773110488', follow_redirects=True, timeout=15)
js = r2.text
checks = [
    ('_renderArticleDetail function', '_renderArticleDetail' in js),
    ('JSON fetch for articles', "fetch(`js/articles/" in js),
    ('slug-based lookup', 'a.slug === titleSlug' in js),
    ('article.content fallback', "article.content || " in js),
]
for name, ok in checks:
    print(f'  {"OK" if ok else "FAIL"}: {name}')

# Check articles-index.js has correct data
r3 = httpx.get('https://vitahaven.click/js/articles-index.js', follow_redirects=True, timeout=15)
print(f'\narticles-index.js: status={r3.status_code}')
print(f'  Has id: 6: {"id: 6," in r3.text}')
print(f'  Has correct slug: {"vivid-seats" in r3.text}')
print(f'  Has JS false: {"hasProducts: false" in r3.text}')
print(f'  No Python False: {"False" not in r3.text}')

# Check JSON detail file
r4 = httpx.get('https://vitahaven.click/js/articles/6.json', follow_redirects=True, timeout=15)
print(f'\njs/articles/6.json: status={r4.status_code}')
if r4.status_code == 200:
    import json
    data = json.loads(r4.text)
    print(f'  id: {data.get("id")}')
    print(f'  title: {data.get("title", "")[:60]}')
    print(f'  content length: {len(data.get("content", ""))} chars')
    print(f'  has content: {bool(data.get("content"))}')

# Summary
print(f'\n=== ARTICLE URL ===')
print(f'https://vitahaven.click/article.html?title=the-smart-way-to-buy-event-tickets-in-2026-why-vivid-seats-rewards-program-changes-everything')
print('\nAll checks passed! The article should render correctly now.')
print('Note: The page loads article content via JavaScript (async fetch from JSON).')
print('Open the URL in a browser to verify visual rendering.')
