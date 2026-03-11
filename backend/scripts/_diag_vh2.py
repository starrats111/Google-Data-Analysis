"""Diagnose vitahaven article 7 - missing content and images"""
import paramiko, sys, json, re
sys.stdout.reconfigure(encoding='utf-8')
pkey = paramiko.RSAKey.from_private_key_file(r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem")
bt = paramiko.SSHClient()
bt.set_missing_host_key_policy(paramiko.AutoAddPolicy())
bt.connect("52.74.221.116", 22, "ubuntu", pkey=pkey, timeout=15)
def r(cmd, t=15):
    stdin, stdout, stderr = bt.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

vh = "/www/wwwroot/vitahaven.click"

# 1. article.html script order
print("=== 1. article.html scripts ===")
print(r(f"grep -n 'script' {vh}/article.html | grep -v '<!--'"))

# 2. articles-index.js
print("\n=== 2. articles-index.js ===")
print(r(f"cat {vh}/js/articles-index.js"))

# 3. data.js - check articles variable
print("\n=== 3. data.js first 20 lines ===")
print(r(f"head -20 {vh}/js/data.js"))

# 4. main.js - loadArticle function
print("\n=== 4. main.js loadArticle ===")
print(r(f"grep -n 'loadArticle\\|function.*article\\|URLSearchParams\\|title.*param\\|slug.*param' {vh}/js/main.js | head -20"))

# 5. 7.json content
print("\n=== 5. 7.json ===")
raw = r(f"cat {vh}/js/articles/7.json")
try:
    data = json.loads(raw)
    print(f"id: {data.get('id')}")
    print(f"slug: {data.get('slug')}")
    print(f"title: {data.get('title')}")
    print(f"author: {data.get('author')}")
    print(f"image: {data.get('image', '')[:80]}")
    content = data.get('content', '')
    print(f"content type: {type(content).__name__}, length: {len(content)}")
    imgs = re.findall(r'<img[^>]+src="([^"]+)"', content)
    print(f"img tags in content: {len(imgs)}")
    for img in imgs:
        print(f"  {img[:80]}")
except Exception as e:
    print(f"Parse error: {e}")
    print(raw[:500])

# 6. Image directory
print(f"\n=== 6. Image dir ===")
slug = "post-building-the-ultimate-home-gym-a-complete-guide-to-major-fitness-equipment"
print(r(f"ls -la {vh}/image/{slug}/ 2>/dev/null || echo 'NOT FOUND'"))

# 7. main.js article loading logic
print("\n=== 7. main.js article loading (around loadArticle) ===")
print(r(f"sed -n '/function.*loadArticle\\|function.*showArticle\\|function.*renderArticle/,/^function /p' {vh}/js/main.js | head -60"))

# 8. Check if there's a fetch fallback
print("\n=== 8. fetch in main.js ===")
print(r(f"grep -n 'fetch\\|articles.*json\\|js/articles' {vh}/js/main.js | head -15"))

# 9. How does the page get the title param?
print("\n=== 9. URL param handling ===")
print(r(f"grep -n 'URLSearchParams\\|getUrlParam\\|location.search\\|title.*=\\|slug.*=' {vh}/js/main.js | head -10"))

bt.close()
