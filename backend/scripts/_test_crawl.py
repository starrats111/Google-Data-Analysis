import paramiko, sys, json
sys.stdout.reconfigure(encoding='utf-8')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', username='admin', password='A123456', timeout=10)

sftp = ssh.open_sftp()
with sftp.open("/tmp/test_crawl.py", "w") as f:
    f.write('''
import sys, os, json
sys.path.insert(0, "/home/admin/Google-Data-Analysis/backend")
os.chdir("/home/admin/Google-Data-Analysis/backend")

from app.services.merchant_crawler import crawl, search_images
from app.config import settings

# Test 1: Check Pexels API key
print(f"Pexels key loaded: {'YES' if settings.PEXELS_API_KEY else 'NO'}")
print(f"Key value: {settings.PEXELS_API_KEY[:10]}..." if settings.PEXELS_API_KEY else "Key: empty")

# Test 2: Try Pexels search
print("\\n--- Test Pexels search ---")
try:
    imgs = search_images("luxury travel products", count=5)
    print(f"Pexels results: {len(imgs)} images")
    for i, img in enumerate(imgs[:3]):
        print(f"  {i+1}: {img[:80]}...")
except Exception as e:
    print(f"Pexels error: {e}")

# Test 3: Try Unsplash search
print("\\n--- Test Unsplash search ---")
try:
    imgs = search_images("travel destination", count=5)
    print(f"Results: {len(imgs)} images")
except Exception as e:
    print(f"Error: {e}")

# Test 4: Try crawling a sample travel site
print("\\n--- Test crawl ---")
try:
    result = crawl("https://www.viator.com")
    print(f"Crawl failed: {result.get('crawl_failed')}")
    print(f"Brand: {result.get('brand_name')}")
    pages = result.get('pages', [])
    total_imgs = 0
    for i, page in enumerate(pages):
        imgs = page.get('images', [])
        total_imgs += len(imgs)
        print(f"  Page {i}: {page.get('url', '?')[:60]} - {len(imgs)} images")
        for img in imgs[:3]:
            print(f"    {img[:80]}...")
    print(f"Total images: {total_imgs}")
except Exception as e:
    print(f"Crawl error: {e}")
''')
sftp.close()

stdin, stdout, stderr = ssh.exec_command(
    'cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 /tmp/test_crawl.py 2>&1',
    timeout=60
)
out = stdout.read().decode('utf-8', errors='replace')
print(out)
ssh.close()
