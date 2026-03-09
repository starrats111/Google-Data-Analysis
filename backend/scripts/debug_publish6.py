"""排查6：AuraBloom main.js + MID 8005157 + 正确DB"""
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
print("1. AuraBloom assets/js/main.js")
print("=" * 60)
try:
    resp = httpx.get("https://aura-bloom.top/assets/js/main.js", timeout=15, follow_redirects=True)
    print(f"Status: {resp.status_code}, Size: {len(resp.text)}")
    # 找 articles/data 相关的代码
    import re
    text = resp.text
    # 搜索 fetch/load/articles 关键词
    for pattern in [r'articles-index', r'articlesIndex', r'fetch\(["\']([^"\']+)', r'\.json', r'articles\s*=']:
        matches = re.findall(pattern, text)
        if matches:
            print(f"  Pattern '{pattern}': {matches[:5]}")
    # 打印包含 articles 的行
    for line in text.split('\n'):
        if 'article' in line.lower() and ('fetch' in line.lower() or 'load' in line.lower() or 'json' in line.lower() or 'index' in line.lower()):
            print(f"  Line: {line.strip()[:200]}")
    # 检查 articlesIndex 变量
    if 'articlesIndex' in text:
        idx = text.index('articlesIndex')
        print(f"  articlesIndex context: ...{text[max(0,idx-50):idx+200]}...")
except Exception as e:
    print(f"Error: {e}")

print("\n" + "=" * 60)
print("2. 列出 AuraBloom assets 目录")
print("=" * 60)
for path in ["/assets/", "/assets/js/", "/assets/data/", "/assets/js/articles-index.js",
             "/assets/articles-index.js", "/assets/js/data.js"]:
    try:
        resp = httpx.get(f"https://aura-bloom.top{path}", timeout=10, follow_redirects=True)
        if resp.status_code == 200 and len(resp.text) > 50:
            print(f"  FOUND: {path} (size={len(resp.text)})")
    except:
        pass

print("\n" + "=" * 60)
print("3. 查询主数据库中的 MID 8005157")
print("=" * 60)
out, err = ssh_exec("""cd /home/admin/Google-Data-Analysis/backend && python3 << 'PYEOF'
import sqlite3
conn = sqlite3.connect('google_analysis.db')
c = conn.cursor()

# 直接查询
rows = c.execute("SELECT merchant_id, merchant_name, site_url, platform_code FROM affiliate_merchants WHERE merchant_id = '8005157'").fetchall()
if rows:
    for r in rows:
        print(f"FOUND: MID={r[0]}, Name={r[1]}, URL={r[2]}, Platform={r[3]}")
else:
    print("MID 8005157 not found")
    # 搜索名称包含 fitness/certified 的
    rows = c.execute("SELECT merchant_id, merchant_name, site_url FROM affiliate_merchants WHERE merchant_name LIKE '%fitness%' OR merchant_name LIKE '%certified%' OR merchant_name LIKE '%wellness%' OR merchant_name LIKE '%trainer%' LIMIT 10").fetchall()
    if rows:
        print("Similar merchants:")
        for r in rows:
            print(f"  MID={r[0]}, Name={r[1]}, URL={r[2]}")
    
    # 也搜8005开头的
    rows = c.execute("SELECT merchant_id, merchant_name, site_url FROM affiliate_merchants WHERE merchant_id LIKE '8005%' LIMIT 10").fetchall()
    if rows:
        print("MIDs starting with 8005:")
        for r in rows:
            print(f"  MID={r[0]}, Name={r[1]}, URL={r[2]}")

# 查看 luchu_websites 表
c.execute("SELECT * FROM luchu_websites LIMIT 5")
cols = [d[0] for d in c.description]
print(f"\\nluchu_websites columns: {cols}")
rows = c.fetchall()
for r in rows:
    print(f"  {dict(zip(cols, r))}")

conn.close()
PYEOF
""")
print(out)
if err:
    print("ERR:", err[:500])

print("\n" + "=" * 60)
print("4. 查看 PubSite 的完整配置")
print("=" * 60)
out, err = ssh_exec("""cd /home/admin/Google-Data-Analysis/backend && python3 << 'PYEOF'
import sqlite3
conn = sqlite3.connect('google_analysis.db')
c = conn.cursor()
c.execute("SELECT * FROM pub_sites")
cols = [d[0] for d in c.description]
rows = c.fetchall()
print(f"pub_sites columns: {cols}")
for r in rows:
    print(dict(zip(cols, r)))
conn.close()
PYEOF
""")
print(out)
if err:
    print("ERR:", err[:500])
