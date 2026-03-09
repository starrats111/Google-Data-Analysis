"""排查8：获取AuraBloom main.js + 测试爬取NASM"""
import paramiko

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

def ssh_exec(cmd, timeout=60):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, PORT, USER, PASS, timeout=10)
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    client.close()
    return out, err

print("=" * 60)
print("1. AuraBloom main.js（从服务器获取，避免编码问题）")
print("=" * 60)
out, err = ssh_exec("curl -s https://aura-bloom.top/assets/js/main.js 2>/dev/null | head -100")
print(out[:5000])

print("\n" + "=" * 60)
print("2. AuraBloom main.js 中与 articles 相关的部分")
print("=" * 60)
out, err = ssh_exec("curl -s https://aura-bloom.top/assets/js/main.js 2>/dev/null | grep -i 'article\\|fetch\\|json\\|index\\|load'")
print(out[:3000])

print("\n" + "=" * 60)
print("3. 检查 AuraBloom 是否有 GitHub 仓库")
print("=" * 60)
# 查看 HTML 中是否有 repo 线索
out, err = ssh_exec("curl -s https://aura-bloom.top/ 2>/dev/null | head -30")
print(out[:2000])

print("\n" + "=" * 60)
print("4. 测试爬取 NASM (MID 8005157) 网站图片")
print("=" * 60)
out, err = ssh_exec("""cd /home/admin/Google-Data-Analysis/backend && python3 << 'PYEOF'
import sys
sys.path.insert(0, '.')
from app.services.merchant_crawler import crawl
result = crawl("https://www.nasm.org")
if result.get("crawl_failed"):
    print(f"CRAWL FAILED: {result.get('error')}")
else:
    print(f"Brand: {result.get('brand_name')}")
    all_images = []
    for page in result.get("pages", []):
        all_images.extend(page.get("images", []))
    seen = set()
    unique = []
    for img in all_images:
        if img not in seen:
            seen.add(img)
            unique.append(img)
    print(f"Total unique images: {len(unique)}")
    for i, img in enumerate(unique[:15]):
        print(f"  [{i}] {img[:120]}")
PYEOF
""", timeout=120)
print(out)
if err:
    print("ERR:", err[:1000])

print("\n" + "=" * 60)
print("5. 查看 GitHub 上是否有 AuraBloom 仓库")
print("=" * 60)
out, err = ssh_exec("curl -s 'https://api.github.com/users/starrats111/repos?per_page=50' 2>/dev/null | python3 -c \"import sys,json; repos=json.load(sys.stdin); [print(r['name'],r.get('homepage','')) for r in repos]\" 2>/dev/null")
print(out[:2000])
if err:
    print("ERR:", err[:500])
