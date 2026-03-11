"""Check article 7 details and current images"""
import paramiko, sys, json
sys.stdout.reconfigure(encoding='utf-8')
pkey = paramiko.RSAKey.from_private_key_file(r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem")
bt = paramiko.SSHClient()
bt.set_missing_host_key_policy(paramiko.AutoAddPolicy())
bt.connect("52.74.221.116", 22, "ubuntu", pkey=pkey, timeout=15)
def r(cmd, t=15):
    stdin, stdout, stderr = bt.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

br = "/www/wwwroot/bloomroots.top"

# 1. Full 7.json
print("=== 7.json ===")
print(r(f"cat {br}/js/articles/7.json"))

# 2. Image directory
slug = "post-no-palm-oil-or-soy-choosing-purer-organic-nutrition-for-your-baby"
print(f"\n=== Image dir: {br}/image/{slug}/ ===")
print(r(f"ls -la {br}/image/{slug}/ 2>/dev/null || echo 'NOT FOUND'"))

# 3. Check all image references in the article
print("\n=== Image references in 7.json ===")
raw = r(f"cat {br}/js/articles/7.json")
try:
    data = json.loads(raw)
    print(f"hero image: {data.get('image')}")
    print(f"heroImage: {data.get('heroImage')}")
    print(f"author: {data.get('author')}")
    # Find img tags in content
    content = data.get('content', '')
    import re
    imgs = re.findall(r'<img[^>]+src="([^"]+)"', content)
    print(f"\nContent images ({len(imgs)}):")
    for img in imgs:
        print(f"  {img}")
except:
    print("Failed to parse JSON")

# 4. Check articles-index.js
print("\n=== articles-index.js ===")
print(r(f"cat {br}/js/articles-index.js"))

# 5. index.html script order
print("\n=== index.html scripts ===")
print(r(f"grep -n 'script' {br}/index.html | grep -v '<!--'"))

bt.close()
