import paramiko, sys, time, re
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

sftp = ssh.open_sftp()
with sftp.open("/tmp/fix_cache.py", "w") as f:
    f.write('''
import sys, os, re, time
sys.path.insert(0, "/home/admin/Google-Data-Analysis/backend")
os.chdir("/home/admin/Google-Data-Analysis/backend")

from app.services.remote_publisher import RemotePublisher

pub = RemotePublisher()
ssh_client = pub._connect()
sftp = ssh_client.open_sftp()

SITE_ROOT = "/www/wwwroot/zontri.top"
ts = str(int(time.time()))

# Update cache-busting in all HTML files that reference articles-index.js
html_files = ["article.html", "articles.html", "index.html", "category.html"]
for fname in html_files:
    fpath = f"{SITE_ROOT}/{fname}"
    try:
        with sftp.open(fpath, "r") as f:
            content = f.read().decode("utf-8")
        if "articles-index.js" in content:
            # Replace ?v=anything with ?v=<timestamp>
            new_content = re.sub(
                r'(articles-index\\.js)\\?v=[^"\'\\s>]+',
                f'\\\\1?v={ts}',
                content
            )
            if new_content != content:
                with sftp.open(fpath, "w") as f:
                    f.write(new_content.encode("utf-8"))
                print(f"[OK] {fname}: cache-busting updated to v={ts}")
            else:
                # Maybe no ?v= param at all, add it
                new_content = content.replace(
                    'articles-index.js"',
                    f'articles-index.js?v={ts}"'
                ).replace(
                    "articles-index.js'",
                    f"articles-index.js?v={ts}'"
                )
                if new_content != content:
                    with sftp.open(fpath, "w") as f:
                        f.write(new_content.encode("utf-8"))
                    print(f"[OK] {fname}: cache-busting added v={ts}")
                else:
                    print(f"[SKIP] {fname}: no change needed")
        else:
            print(f"[SKIP] {fname}: no articles-index.js reference")
    except FileNotFoundError:
        print(f"[SKIP] {fname}: file not found")
    except Exception as e:
        print(f"[ERROR] {fname}: {e}")

# Verify
print("\\nVerification:")
for fname in html_files:
    fpath = f"{SITE_ROOT}/{fname}"
    try:
        with sftp.open(fpath, "r") as f:
            content = f.read().decode("utf-8")
        import re as _re
        matches = _re.findall(r'articles-index\\.js[^"\'\\s>]*', content)
        for m in matches:
            print(f"  {fname}: {m}")
    except:
        pass

sftp.close()
ssh_client.close()
print("\\nCache fix done!")
''')
sftp.close()

stdin, stdout, stderr = ssh.exec_command(
    "cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 /tmp/fix_cache.py 2>&1",
    timeout=30
)
print(stdout.read().decode('utf-8', errors='replace'), flush=True)

ssh.close()
