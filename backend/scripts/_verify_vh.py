"""Verify vitahaven article page works"""
import httpx, json, sys
sys.stdout.reconfigure(encoding='utf-8')

url = 'https://vitahaven.click/article.html?title=the-smart-way-to-buy-event-tickets-in-2026-why-vivid-seats-rewards-program-changes-everything'
r = httpx.get(url, follow_redirects=True, timeout=15)
print(f'Article page: status={r.status_code}, length={len(r.text)}')

html = r.text
checks = {
    'articles-index.js loaded': 'articles-index.js' in html,
    'main.js loaded': 'main.js' in html,
    'JSON fetch logic': 'fetch(`js/articles/' in html or 'fetch(\\`js/articles/' in html,
    '_renderArticleDetail': '_renderArticleDetail' in html,
}
for k, v in checks.items():
    print(f'  {"OK" if v else "MISSING"}: {k}')

# Verify JS/JSON files
for f in ['js/articles-index.js', 'js/articles/6.json', 'js/main.js']:
    r2 = httpx.get(f'https://vitahaven.click/{f}', follow_redirects=True, timeout=15)
    print(f'\n{f}: status={r2.status_code}, length={len(r2.text)}')
    if '6.json' in f and r2.status_code == 200:
        data = json.loads(r2.text)
        title = data.get('title', 'N/A')
        content_len = len(data.get('content', ''))
        print(f'  Title: {title[:80]}')
        print(f'  Content: {content_len} chars')

# Check main.js has the fetch logic
r3 = httpx.get('https://vitahaven.click/js/main.js', follow_redirects=True, timeout=15)
if r3.status_code == 200:
    js = r3.text
    if 'fetch(`js/articles/' in js:
        print('\nOK: main.js has JSON fetch logic')
    else:
        print('\nWARNING: main.js missing JSON fetch logic')
    if '_renderArticleDetail' in js:
        print('OK: main.js has _renderArticleDetail function')
    if 'a.slug === titleSlug' in js:
        print('OK: main.js has slug-based lookup')
