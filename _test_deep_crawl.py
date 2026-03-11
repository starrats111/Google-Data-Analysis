import paramiko
import time
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

test_script = r'''
import sys, os, re
sys.path.insert(0, '/home/admin/Google-Data-Analysis/backend')

url = "https://1stphorm.com/"

# Test 1: httpx - what do we actually get?
print("=== httpx result analysis ===")
import httpx
headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.google.com/",
}
with httpx.Client(timeout=20, follow_redirects=True, headers=headers) as c:
    r = c.get(url)
    print(f"Status: {r.status_code}, Length: {len(r.text)}")
    title = re.search(r'<title>(.*?)</title>', r.text, re.I)
    print(f"Title: {title.group(1)[:80] if title else 'NONE'}")
    imgs = re.findall(r'<img[^>]+src=["\']([^"\']+)', r.text)
    print(f"<img> tags: {len(imgs)}")
    # Check for SPA indicators
    scripts = re.findall(r'<script[^>]*src=["\']([^"\']+)', r.text)
    print(f"<script> tags: {len(scripts)}")
    # Check for common SPA frameworks
    if '__NEXT_DATA__' in r.text:
        print("Framework: Next.js")
    elif 'window.__NUXT__' in r.text:
        print("Framework: Nuxt.js")
    elif 'id="app"' in r.text or 'id="root"' in r.text:
        print("Framework: SPA (React/Vue)")
    # Show first 500 chars of body
    body = re.search(r'<body[^>]*>(.*)', r.text, re.S)
    if body:
        print(f"Body start: {body.group(1)[:500]}")

# Test 2: cloudscraper with Accept-Encoding fix
print("\n=== cloudscraper (no br encoding) ===")
try:
    import cloudscraper
    scraper = cloudscraper.create_scraper(
        browser={"browser": "chrome", "platform": "windows", "mobile": False}
    )
    # Disable brotli to avoid decompression errors
    scraper.headers.update({
        "Accept-Encoding": "gzip, deflate",
    })
    r = scraper.get(url, timeout=25)
    print(f"Status: {r.status_code}, Length: {len(r.text)}")
    if r.status_code == 200:
        title = re.search(r'<title>(.*?)</title>', r.text, re.I)
        print(f"Title: {title.group(1)[:80] if title else 'NONE'}")
        imgs = re.findall(r'<img[^>]+src=["\']([^"\']+)', r.text)
        print(f"<img> tags: {len(imgs)}")
        for img in imgs[:5]:
            print(f"  {img[:120]}")
except Exception as e:
    print(f"Error: {type(e).__name__}: {e}")

# Test 3: requests with no Accept-Encoding
print("\n=== requests (plain) ===")
try:
    import requests
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.google.com/",
    })
    r = session.get(url, timeout=25, allow_redirects=True)
    print(f"Status: {r.status_code}, Length: {len(r.text)}")
    if r.status_code == 200:
        title = re.search(r'<title>(.*?)</title>', r.text, re.I)
        print(f"Title: {title.group(1)[:80] if title else 'NONE'}")
        imgs = re.findall(r'<img[^>]+src=["\']([^"\']+)', r.text)
        print(f"<img> tags: {len(imgs)}")
except Exception as e:
    print(f"Error: {type(e).__name__}: {e}")
'''

sftp = ssh.open_sftp()
with sftp.open('/tmp/test_deep.py', 'w') as f:
    f.write(test_script)
sftp.close()

stdin, stdout, stderr = ssh.exec_command(
    'cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && timeout 60 python /tmp/test_deep.py 2>&1'
)
stdout.channel.settimeout(65)
try:
    print(stdout.read().decode()[-4000:])
except:
    print("(timeout)")

ssh.close()
