import paramiko
import time
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

# 1. Install cloudscraper in venv
print("[1] Installing cloudscraper...")
stdin, stdout, stderr = ssh.exec_command(
    'cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && pip install cloudscraper 2>&1 | tail -5'
)
print(stdout.read().decode())

# 2. Test crawling 1stphorm.com with different methods
print("[2] Testing 1stphorm.com crawl...")
test_script = r'''
import sys, os
sys.path.insert(0, '/home/admin/Google-Data-Analysis/backend')
os.chdir('/home/admin/Google-Data-Analysis/backend')

url = "https://1stphorm.com/"

# Method 1: httpx with stealth headers
print("--- httpx stealth ---")
import httpx, random, time
headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.google.com/search?q=1stphorm+supplements",
    "DNT": "1",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Cookie": "_ga=GA1.2.123456789.1709000000; _gid=GA1.2.987654321.1709900000",
}
try:
    with httpx.Client(timeout=20, follow_redirects=True, headers=headers) as c:
        r = c.get(url)
        print(f"  Status: {r.status_code}, Len: {len(r.text)}")
        if r.status_code == 403:
            # Check if Cloudflare
            if 'cloudflare' in r.text.lower() or 'cf-' in str(r.headers).lower():
                print("  -> Cloudflare protection detected!")
            print(f"  Headers: {dict(list(r.headers.items())[:5])}")
            print(f"  Body: {r.text[:300]}")
        elif r.status_code == 200:
            import re
            t = re.search(r'<title>(.*?)</title>', r.text, re.I)
            print(f"  Title: {t.group(1)[:80] if t else 'N/A'}")
except Exception as e:
    print(f"  Error: {e}")

# Method 2: httpx HTTP/2
print("\n--- httpx HTTP/2 ---")
try:
    h2_headers = dict(headers)
    h2_headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    with httpx.Client(timeout=20, follow_redirects=True, headers=h2_headers, http2=True) as c:
        r = c.get(url)
        print(f"  Status: {r.status_code}, Len: {len(r.text)}, HTTP: {r.http_version}")
        if r.status_code == 200:
            import re
            t = re.search(r'<title>(.*?)</title>', r.text, re.I)
            print(f"  Title: {t.group(1)[:80] if t else 'N/A'}")
        elif r.status_code == 403:
            print(f"  Body: {r.text[:300]}")
except Exception as e:
    print(f"  Error: {e}")

# Method 3: cloudscraper
print("\n--- cloudscraper ---")
try:
    import cloudscraper
    scraper = cloudscraper.create_scraper(
        browser={"browser": "chrome", "platform": "windows", "mobile": False}
    )
    r = scraper.get(url, timeout=25)
    print(f"  Status: {r.status_code}, Len: {len(r.text)}")
    if r.status_code == 200:
        import re
        t = re.search(r'<title>(.*?)</title>', r.text, re.I)
        print(f"  Title: {t.group(1)[:80] if t else 'N/A'}")
        # Count images
        imgs = re.findall(r'<img[^>]+src=["\']([^"\']+)', r.text)
        print(f"  Images found: {len(imgs)}")
except ImportError:
    print("  cloudscraper not installed!")
except Exception as e:
    print(f"  Error: {type(e).__name__}: {e}")

# Method 4: Full crawl with our module
print("\n--- Full crawl module ---")
try:
    from app.services.merchant_crawler import crawl
    result = crawl(url)
    print(f"  crawl_failed: {result.get('crawl_failed')}")
    print(f"  brand: {result.get('brand_name', '')}")
    pages = result.get('pages', [])
    total_imgs = sum(len(p.get('images', [])) for p in pages)
    print(f"  pages: {len(pages)}, images: {total_imgs}")
    if result.get('error'):
        print(f"  error: {result['error']}")
except Exception as e:
    print(f"  Error: {type(e).__name__}: {e}")
'''

sftp = ssh.open_sftp()
with sftp.open('/tmp/test_1stphorm.py', 'w') as f:
    f.write(test_script)
sftp.close()

stdin, stdout, stderr = ssh.exec_command(
    'cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && timeout 60 python /tmp/test_1stphorm.py 2>&1'
)
stdout.channel.settimeout(65)
try:
    out = stdout.read().decode()
    print(out[-3000:])
except:
    print("(timeout)")

err_out = stderr.read().decode()
if err_out and 'Error' in err_out:
    print(f"STDERR: {err_out[-500:]}")

ssh.close()
print("\nDone!")
