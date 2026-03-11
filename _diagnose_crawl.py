"""诊断 1stphorm.com 爬虫失败原因 + 测试增强后的爬虫"""
import paramiko
import time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

# 1. 检查后端日志中 1stphorm 相关的错误
print("=== 最近的 1stphorm 爬虫日志 ===")
stdin, stdout, stderr = ssh.exec_command("grep -i '1stphorm\\|MerchantCrawler' /home/admin/backend.log | tail -30")
log = stdout.read().decode()
print(log[-2000:] if log else "(no logs)")

# 2. 直接在服务器上测试爬取
print("\n=== 直接测试爬取 1stphorm.com ===")
test_script = '''
import sys
sys.path.insert(0, '/home/admin/Google-Data-Analysis/backend')
import httpx
import random
import time as _time

# Test with different approaches
url = "https://1stphorm.com/"

# Approach 1: Simple Chrome UA
print("\\n--- Test 1: Simple Chrome UA ---")
headers1 = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.google.com/",
}
try:
    with httpx.Client(timeout=20, follow_redirects=True, headers=headers1) as c:
        r = c.get(url)
        print(f"  Status: {r.status_code}, Length: {len(r.text)}")
        if r.status_code == 403:
            print(f"  Response headers: {dict(r.headers)[:500]}")
            print(f"  Body preview: {r.text[:300]}")
except Exception as e:
    print(f"  Error: {e}")

# Approach 2: Full stealth headers + cookies
print("\\n--- Test 2: Full stealth + cookies ---")
headers2 = {
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
    with httpx.Client(timeout=20, follow_redirects=True, headers=headers2) as c:
        r = c.get(url)
        print(f"  Status: {r.status_code}, Length: {len(r.text)}")
        if r.status_code == 403:
            print(f"  Body preview: {r.text[:500]}")
except Exception as e:
    print(f"  Error: {e}")

# Approach 3: HTTP/2
print("\\n--- Test 3: HTTP/2 ---")
headers3 = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.google.com/",
    "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}
try:
    with httpx.Client(timeout=20, follow_redirects=True, headers=headers3, http2=True) as c:
        r = c.get(url)
        print(f"  Status: {r.status_code}, Length: {len(r.text)}, HTTP version: {r.http_version}")
        if r.status_code == 200:
            # Check if it's a Cloudflare challenge page
            if "challenge" in r.text.lower() or "cf-" in str(r.headers).lower():
                print("  WARNING: Cloudflare challenge detected!")
            else:
                print("  SUCCESS! Got real content")
                # Check title
                import re
                title_match = re.search(r'<title>(.*?)</title>', r.text, re.IGNORECASE)
                if title_match:
                    print(f"  Title: {title_match.group(1)[:100]}")
        elif r.status_code == 403:
            print(f"  Body preview: {r.text[:500]}")
except Exception as e:
    print(f"  Error: {e}")

# Approach 4: cloudscraper (if available)
print("\\n--- Test 4: cloudscraper ---")
try:
    import cloudscraper
    scraper = cloudscraper.create_scraper(browser={"browser": "chrome", "platform": "windows", "mobile": False})
    r = scraper.get(url, timeout=20)
    print(f"  Status: {r.status_code}, Length: {len(r.text)}")
    if r.status_code == 200:
        import re
        title_match = re.search(r'<title>(.*?)</title>', r.text, re.IGNORECASE)
        if title_match:
            print(f"  Title: {title_match.group(1)[:100]}")
except ImportError:
    print("  cloudscraper not installed")
except Exception as e:
    print(f"  Error: {e}")
'''

# Write test script to server
sftp = ssh.open_sftp()
with sftp.open('/tmp/test_crawl.py', 'w') as f:
    f.write(test_script)
sftp.close()

stdin, stdout, stderr = ssh.exec_command(
    'cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python /tmp/test_crawl.py 2>&1'
)
# Wait for output
stdout.channel.settimeout(45)
try:
    output = stdout.read().decode()
    print(output[-3000:])
except Exception as e:
    print(f"Timeout reading output: {e}")

err = stderr.read().decode()
if err:
    print(f"\nSTDERR: {err[-500:]}")

ssh.close()
print("\nDone!")
