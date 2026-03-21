"""Test HTTPS URL access"""
import urllib.request
import ssl

ctx = ssl.create_default_context()

urls = [
    "https://google-data-analysis.top/user/login",
    "https://google-data-analysis.top/admin/login",
    "https://api.google-data-analysis.top/user/login",
]

for url in urls:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        resp = urllib.request.urlopen(req, timeout=10, context=ctx)
        print(f"  {resp.status} - {url}")
    except urllib.error.HTTPError as e:
        print(f"  {e.code} - {url}")
    except Exception as e:
        print(f"  ERROR - {url}: {e}")
