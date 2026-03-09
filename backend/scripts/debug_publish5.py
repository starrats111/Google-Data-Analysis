"""排查5：数据库路径 + MID 8005157 + AuraBloom 网站结构"""
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
print("1. 找数据库文件")
print("=" * 60)
out, err = ssh_exec("find /home/admin/ -name '*.db' -type f 2>/dev/null | head -10")
print(out or "(未找到)")
out, err = ssh_exec("grep -r 'DATABASE_URL\\|SQLALCHEMY\\|sqlite' /home/admin/Google-Data-Analysis/backend/.env 2>/dev/null")
print(out or "(环境变量中未找到)")

print("\n" + "=" * 60)
print("2. 使用正确路径查询 MID 8005157")
print("=" * 60)
out, err = ssh_exec("""find /home/admin/ -name '*.db' -type f 2>/dev/null | while read db; do
  echo "=== DB: $db ==="
  sqlite3 "$db" ".tables" 2>/dev/null | head -5
  sqlite3 "$db" "SELECT merchant_id, merchant_name, site_url FROM affiliate_merchants WHERE merchant_id = '8005157' LIMIT 1;" 2>/dev/null
done""")
print(out or "(未找到)")
if err:
    print("ERR:", err[:500])

print("\n" + "=" * 60)
print("3. 获取 AuraBloom 首页 HTML 结构")
print("=" * 60)
try:
    resp = httpx.get("https://aura-bloom.top", timeout=15, follow_redirects=True)
    html = resp.text
    # 找 script 标签
    import re
    scripts = re.findall(r'<script[^>]*src="([^"]+)"', html)
    print("Scripts found:", scripts)
    # 找文章数据的加载方式
    if 'articles' in html.lower():
        for line in html.split('\n'):
            if 'article' in line.lower() and ('src' in line.lower() or 'fetch' in line.lower() or 'json' in line.lower()):
                print("Article ref:", line.strip()[:200])
    # 检查是否用了某个框架
    if 'next' in html.lower():
        print("Framework: Next.js")
    elif 'gatsby' in html.lower():
        print("Framework: Gatsby")
    elif 'react' in html.lower():
        print("Framework: React")
    elif 'vue' in html.lower():
        print("Framework: Vue")
    # 检查 data 属性
    data_refs = re.findall(r'(?:data-|src="|href=")[^"]*(?:article|story|post|blog)[^"]*', html[:5000])
    print("Data refs:", data_refs[:10])
except Exception as e:
    print(f"Error: {e}")

print("\n" + "=" * 60)
print("4. 检查 AuraBloom 常见数据文件路径")
print("=" * 60)
for path in ["/js/articles-index.js", "/data/articles.json", "/articles.json",
             "/js/articles.js", "/api/articles", "/_next/data", "/js/main.js",
             "/js/data.js", "/assets/articles-index.js"]:
    try:
        resp = httpx.get(f"https://aura-bloom.top{path}", timeout=10, follow_redirects=True)
        if resp.status_code == 200:
            print(f"  FOUND: {path} (size={len(resp.text)})")
            if len(resp.text) < 500:
                print(f"    Content: {resp.text[:300]}")
        else:
            print(f"  {resp.status_code}: {path}")
    except Exception as e:
        print(f"  ERROR: {path} - {e}")

print("\n" + "=" * 60)
print("5. 测试直接爬取可能的 8005157 网站")
print("=" * 60)
out, err = ssh_exec("""cd /home/admin/Google-Data-Analysis/backend && python3 << 'PYEOF'
import os, sys
sys.path.insert(0, '.')
os.environ.setdefault('PYTHONPATH', '.')

# 找 DB
import glob
dbs = glob.glob('/home/admin/**/*.db', recursive=True)
print("DB files:", dbs[:5])

for db_path in dbs:
    try:
        import sqlite3
        conn = sqlite3.connect(db_path)
        c = conn.cursor()
        tables = [t[0] for t in c.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        if 'affiliate_merchants' in tables:
            print(f"\\nUsing DB: {db_path}")
            rows = c.execute("SELECT merchant_id, merchant_name, site_url, platform_code FROM affiliate_merchants WHERE merchant_id = '8005157'").fetchall()
            if rows:
                for r in rows:
                    print(f"  MID={r[0]}, Name={r[1]}, URL={r[2]}, Platform={r[3]}")
            else:
                print("  MID 8005157 not found, trying LIKE search...")
                rows = c.execute("SELECT merchant_id, merchant_name, site_url FROM affiliate_merchants WHERE merchant_name LIKE '%fitness%' OR merchant_name LIKE '%certified%' LIMIT 5").fetchall()
                for r in rows:
                    print(f"  Similar: MID={r[0]}, Name={r[1]}, URL={r[2]}")
        conn.close()
    except Exception as e:
        pass
PYEOF
""")
print(out)
if err:
    print("ERR:", err[:500])
