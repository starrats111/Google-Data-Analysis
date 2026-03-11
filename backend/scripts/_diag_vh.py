"""Diagnose vitahaven article - missing images"""
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
slug = "building-the-ultimate-home-gym-a-complete-guide-to-major-fitness-equipment"

# 1. Check article JSON
print("=== Article JSON ===")
# Find the article ID first
raw = r(f"cat {vh}/js/articles-index.js")
print(raw[:500])

# 2. Find article json files
print("\n=== js/articles/ directory ===")
print(r(f"ls -la {vh}/js/articles/"))

# 3. Check the specific article json
print("\n=== Find article by slug ===")
print(r(f"grep -rl '{slug}' {vh}/js/articles/ 2>/dev/null"))

# 4. Check image directory
print(f"\n=== Image dir: post-{slug} ===")
print(r(f"ls -la {vh}/image/post-{slug}/ 2>/dev/null || echo 'NOT FOUND'"))

# 5. Check data.js for the article
print("\n=== data.js search ===")
print(r(f"grep -c '{slug}' {vh}/js/data.js 2>/dev/null || echo 'not in data.js'"))

# 6. Read the article JSON to check image references
files = r(f"grep -rl '{slug}' {vh}/js/articles/ 2>/dev/null").strip().split('\n')
for f_path in files:
    if f_path:
        print(f"\n=== Content of {f_path} (first 2000 chars) ===")
        content = r(f"head -c 2000 {f_path}")
        print(content)
        # Count img tags
        full = r(f"cat {f_path}")
        imgs = re.findall(r'<img[^>]+src="([^"]+)"', full)
        print(f"\nImage tags found: {len(imgs)}")
        for img in imgs:
            print(f"  {img}")
            # Check if image exists
            if img.startswith('image/'):
                exists = r(f"test -f {vh}/{img} && echo 'EXISTS' || echo 'MISSING'")
                size = r(f"stat -c%s {vh}/{img} 2>/dev/null || echo 0")
                print(f"    -> {exists} ({size} bytes)")

bt.close()
