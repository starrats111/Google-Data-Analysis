"""排查7：获取 AuraBloom main.js 完整内容 + 修正 DB 查询"""
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
print("1. AuraBloom main.js 完整内容")
print("=" * 60)
try:
    resp = httpx.get("https://aura-bloom.top/assets/js/main.js", timeout=15, follow_redirects=True)
    print(resp.text[:6000])
    print("...(截断)...")
    print(resp.text[-3000:])
except Exception as e:
    print(f"Error: {e}")

print("\n" + "=" * 60)
print("2. 修正查询 MID 8005157")
print("=" * 60)
out, err = ssh_exec("""cd /home/admin/Google-Data-Analysis/backend && python3 << 'PYEOF'
import sqlite3
conn = sqlite3.connect('google_analysis.db')
c = conn.cursor()

# 先看列名
c.execute("PRAGMA table_info(affiliate_merchants)")
cols = c.fetchall()
print("affiliate_merchants columns:", [col[1] for col in cols])

# 查询 8005157
c.execute("SELECT * FROM affiliate_merchants WHERE merchant_id = '8005157' LIMIT 1")
cols_names = [d[0] for d in c.description]
rows = c.fetchall()
if rows:
    for r in rows:
        d = dict(zip(cols_names, r))
        print(f"FOUND: {d}")
else:
    print("MID 8005157 not found, trying broader search...")
    c.execute("SELECT merchant_id, merchant_name, website_url FROM affiliate_merchants WHERE merchant_id LIKE '8005%' LIMIT 10")
    for r in c.fetchall():
        print(f"  MID={r[0]}, Name={r[1]}, URL={r[2]}")

conn.close()
PYEOF
""")
print(out)
if err:
    print("ERR:", err[:1000])

print("\n" + "=" * 60)
print("3. luchu_websites 表")
print("=" * 60)
out, err = ssh_exec("""cd /home/admin/Google-Data-Analysis/backend && python3 << 'PYEOF'
import sqlite3
conn = sqlite3.connect('google_analysis.db')
c = conn.cursor()
try:
    c.execute("SELECT * FROM luchu_websites")
    cols = [d[0] for d in c.description]
    print(f"Columns: {cols}")
    for r in c.fetchall():
        d = dict(zip(cols, r))
        print(d)
except Exception as e:
    print(f"Error: {e}")
conn.close()
PYEOF
""")
print(out)
if err:
    print("ERR:", err[:500])
