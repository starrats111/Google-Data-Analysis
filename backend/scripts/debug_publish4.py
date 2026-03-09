"""排查3：AuraBloom 网站源码位置 + MID 8005157 URL + 测试爬取"""
import paramiko
import httpx

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
print("1. 获取 AuraBloom 网站的 articles-index.js")
print("=" * 60)
try:
    resp = httpx.get("https://aura-bloom.top/js/articles-index.js", timeout=15, follow_redirects=True)
    print(f"Status: {resp.status_code}")
    print(resp.text[:2000])
except Exception as e:
    print(f"Error: {e}")

print("\n" + "=" * 60)
print("2. 查找 MID 8005157 相关信息")
print("=" * 60)
out, err = ssh_exec("""cd /home/admin/Google-Data-Analysis/backend && python3 -c "
import sqlite3
conn = sqlite3.connect('data/app.db')
c = conn.cursor()
# 检查 affiliate_merchants 表结构
c.execute('SELECT name FROM sqlite_master WHERE type=\"table\" AND name LIKE \"%merchant%\"')
tables = c.fetchall()
print('Tables:', tables)
for t in tables:
    c.execute(f'PRAGMA table_info({t[0]})')
    cols = c.fetchall()
    print(f'  {t[0]} columns: {[col[1] for col in cols]}')
# 搜索 8005157
for t in tables:
    try:
        c.execute(f'SELECT * FROM {t[0]} WHERE merchant_id = ? OR mid = ?', ('8005157', '8005157'))
    except:
        try:
            c.execute(f'SELECT * FROM {t[0]} WHERE merchant_id = ?', ('8005157',))
        except:
            continue
    rows = c.fetchall()
    if rows:
        print(f'Found in {t[0]}: {rows[:3]}')
conn.close()
" 2>&1""")
print(out)
if err:
    print("ERR:", err[:500])

print("\n" + "=" * 60)
print("3. 查找 GitHub repos")
print("=" * 60)
out, err = ssh_exec("find /home/admin/ -name '.git' -type d -maxdepth 4 2>/dev/null")
print(out or "(未找到)")
out2, err2 = ssh_exec("cd /home/admin/Google-Data-Analysis && git remote -v 2>/dev/null")
print(out2)

print("\n" + "=" * 60)
print("4. 检查 AuraBloom 是否在 Luchu 中（可能是别名）")
print("=" * 60)
# 检查每个 Luchu 网站的 articles-index.js 开头
for site in ["AlluraHub", "EverydayHaven", "VitaSphere", "Zontri", "BloomRoots", "Quiblo", "VitaHaven", "Kivanta", "NovaNest"]:
    out, err = ssh_exec(f"head -5 /home/admin/Google-Data-Analysis/Luchu/{site}/js/articles-index.js 2>/dev/null")
    if out:
        print(f"  {site}: {out.strip()[:100]}")

print("\n" + "=" * 60)
print("5. 对比 server 上的发布目录 vs 网站实际内容")
print("=" * 60)
out, err = ssh_exec("cat /home/admin/sites/aura-bloom-top/js/articles-index.js 2>/dev/null | head -20")
print("Server file:", out[:500] if out else "(空)")
