"""Part 2: Restart backend + fix Baota sites"""
import paramiko, sys, json, time, re
sys.stdout.reconfigure(encoding='utf-8')

# === Restart backend ===
print("=== Restart backend ===")
be = paramiko.SSHClient()
be.set_missing_host_key_policy(paramiko.AutoAddPolicy())
be.connect('47.239.193.33', 22, 'admin', password='A123456', timeout=15)

BACKEND = "/home/admin/Google-Data-Analysis/backend"

# Fire-and-forget: use bash -c with nohup, don't wait for output
be.exec_command(f"cd {BACKEND} && source venv/bin/activate && nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 > /home/admin/backend.log 2>&1 &")
print("Backend start command sent (fire-and-forget)")
time.sleep(6)

# Verify
stdin, stdout, stderr = be.exec_command("ps aux | grep uvicorn | grep -v grep", timeout=10)
stdout.channel.recv_exit_status()
out = stdout.read().decode('utf-8', errors='replace').strip()
print(f"Uvicorn running: {'YES' if out else 'NO'}")
if out:
    print(out[:200])

stdin, stdout, stderr = be.exec_command('curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health', timeout=10)
stdout.channel.recv_exit_status()
health = stdout.read().decode('utf-8', errors='replace').strip()
print(f"Health check: {health}")

# Quick AI test
print("\n=== Quick AI test ===")
stdin, stdout, stderr = be.exec_command(f"""cd {BACKEND} && source venv/bin/activate && python3 -c "
import sys; sys.path.insert(0, '.')
from app.services.article_gen_service import ArticleGenService
svc = ArticleGenService()
result = svc.analyze_merchant({{'raw_text': 'Nike is a global sportswear brand selling shoes, apparel and equipment.', 'brand_name': 'Nike'}}, 'en')
print('Category:', result.get('category', 'MISSING'))
print('Titles:', len(result.get('titles', [])))
print('Keywords:', result.get('keywords', []))
print('First title:', result.get('titles', [dict()])[0] if result.get('titles') else 'NONE')
" """, timeout=60)
stdout.channel.recv_exit_status()
out = stdout.read().decode('utf-8', errors='replace').strip()
err = stderr.read().decode('utf-8', errors='replace').strip()
print(out)
if err:
    print(f"STDERR: {err[:500]}")

be.close()

# === Fix Baota sites ===
print("\n" + "=" * 60)
print("Fixing Baota sites")
print("=" * 60)

pkey = paramiko.RSAKey.from_private_key_file(r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem")
bt = paramiko.SSHClient()
bt.set_missing_host_key_policy(paramiko.AutoAddPolicy())
bt.connect("52.74.221.116", 22, "ubuntu", pkey=pkey, timeout=15)
sftp = bt.open_sftp()

def r(cmd, t=15):
    stdin, stdout, stderr = bt.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

# B1: Fix bloomroots
print("\n--- Fix bloomroots ---")
br_root = "/www/wwwroot/bloomroots.top"

# Read articles-index.js
with sftp.open(f"{br_root}/js/articles-index.js", "r") as f:
    br_idx = f.read().decode("utf-8")
print(f"articles-index.js: {len(br_idx)} chars")

# Change const to var to avoid redeclaration
br_idx = br_idx.replace("const articlesIndex", "var articlesIndex")
br_idx = br_idx.replace("const articles =", "var articles =")

# Add articlesData alias if not present
if "articlesData" not in br_idx:
    br_idx = br_idx.rstrip() + "\n\n// 兼容 script.js\nvar articlesData = articlesIndex;\n"

with sftp.open(f"{br_root}/js/articles-index.js", "w") as f:
    f.write(br_idx.encode("utf-8"))
print("Fixed articles-index.js: const -> var + articlesData alias")

# Fix script.js: remove inline articlesData array
with sftp.open(f"{br_root}/script.js", "r") as f:
    br_script = f.read().decode("utf-8")
print(f"script.js: {len(br_script)} chars")

if "const articlesData" in br_script or "let articlesData" in br_script or "var articlesData" in br_script:
    # Find the full array declaration
    pattern = r'(?:const|let|var)\s+articlesData\s*=\s*\['
    match = re.search(pattern, br_script)
    if match:
        start = match.start()
        bracket_start = match.end() - 1
        depth = 0
        i = bracket_start
        while i < len(br_script):
            ch = br_script[i]
            if ch == '[':
                depth += 1
            elif ch == ']':
                depth -= 1
                if depth == 0:
                    break
            elif ch in ('"', "'", '`'):
                quote = ch
                i += 1
                while i < len(br_script) and br_script[i] != quote:
                    if br_script[i] == '\\':
                        i += 1
                    i += 1
            i += 1
        end = i + 1
        if end < len(br_script) and br_script[end] == ';':
            end += 1
        
        removed_len = end - start
        br_script_new = br_script[:start] + "// articlesData loaded from js/articles-index.js\n" + br_script[end:]
        
        with sftp.open(f"{br_root}/script.js", "w") as f:
            f.write(br_script_new.encode("utf-8"))
        print(f"Removed inline articlesData from script.js ({removed_len} chars)")
    else:
        print("WARNING: Could not find articlesData array pattern")
else:
    print("No articlesData declaration found in script.js")

# B2: Fix vitahaven
print("\n--- Fix vitahaven ---")
vh_root = "/www/wwwroot/vitahaven.click"

with sftp.open(f"{vh_root}/js/articles-index.js", "r") as f:
    vh_idx = f.read().decode("utf-8")

vh_idx = vh_idx.replace("hasProducts: False", "hasProducts: false")
vh_idx = vh_idx.replace("hasProducts: True", "hasProducts: true")

# Change Vivid Seats id from 1 to 6
if "vivid-seats" in vh_idx.lower() and "\n    id: 1," in vh_idx:
    vh_idx = vh_idx.replace("\n    id: 1,", "\n    id: 6,", 1)
    print("Changed Vivid Seats id: 1 -> 6")

with sftp.open(f"{vh_root}/js/articles-index.js", "w") as f:
    f.write(vh_idx.encode("utf-8"))
print("Fixed vitahaven articles-index.js")

# Copy article JSON to js/articles/6.json
slug = "the-smart-way-to-buy-event-tickets-in-2026-why-vivid-seats-rewards-program-changes-everything"
try:
    with sftp.open(f"{vh_root}/articles/{slug}.json", "r") as f:
        vs_data = json.loads(f.read().decode("utf-8"))
    vs_data["id"] = 6
    new_json = json.dumps(vs_data, ensure_ascii=False, indent=2)
    with sftp.open(f"{vh_root}/js/articles/6.json", "w") as f:
        f.write(new_json.encode("utf-8"))
    print(f"Created js/articles/6.json ({len(new_json)} chars)")
except Exception as e:
    print(f"Error: {e}")

# B3: Fix all sites Python booleans
print("\n--- Fix all sites booleans ---")
for domain in ["zontri.top", "vitasphere.top", "everydayhaven.top", "quiblo.top", "allurahub.top"]:
    path = f"/www/wwwroot/{domain}/js/articles-index.js"
    try:
        with sftp.open(path, "r") as f:
            content = f.read().decode("utf-8")
        changed = False
        for old, new in [("hasProducts: False", "hasProducts: false"),
                         ("hasProducts: True", "hasProducts: true"),
                         ("featured: False", "featured: false"),
                         ("featured: True", "featured: true")]:
            if old in content:
                content = content.replace(old, new)
                changed = True
        if changed:
            with sftp.open(path, "w") as f:
                f.write(content.encode("utf-8"))
            print(f"  {domain}: fixed booleans")
        else:
            print(f"  {domain}: OK")
    except Exception as e:
        print(f"  {domain}: {e}")

# B4: Verify bloomroots
print("\n--- Verify bloomroots ---")
out = r(f"head -5 {br_root}/js/articles-index.js")
print(f"articles-index.js head:\n{out}")
out = r(f"head -3 {br_root}/script.js")
print(f"script.js head:\n{out}")

# B5: Verify vitahaven
print("\n--- Verify vitahaven ---")
out = r(f"cat {vh_root}/js/articles-index.js")
print(f"articles-index.js:\n{out}")
out = r(f"ls -la {vh_root}/js/articles/6.json 2>/dev/null")
print(f"6.json: {out}")

sftp.close()
bt.close()

print("\n" + "=" * 60)
print("ALL DONE!")
print("=" * 60)
