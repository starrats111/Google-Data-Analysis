import paramiko, sys, time, re
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

sftp = ssh.open_sftp()

SCRIPT = r'''
import sys, os, re, time
sys.path.insert(0, "/home/admin/Google-Data-Analysis/backend")
os.chdir("/home/admin/Google-Data-Analysis/backend")

from app.services.remote_publisher import RemotePublisher

pub = RemotePublisher()
ssh_client = pub._connect()
sftp = ssh_client.open_sftp()

SITE_ROOT = "/www/wwwroot/zontri.top"
ts = str(int(time.time()))

html_files = ["article.html", "articles.html", "index.html", "category.html"]
for fname in html_files:
    fpath = SITE_ROOT + "/" + fname
    try:
        with sftp.open(fpath, "r") as f:
            content = f.read().decode("utf-8")
        if "articles-index.js" not in content:
            print(f"[SKIP] {fname}: no ref")
            continue
        pattern = re.compile(r'(articles-index\.js)\?v=\d+')
        if pattern.search(content):
            new_content = pattern.sub(r'\1?v=' + ts, content)
        else:
            new_content = content.replace('articles-index.js"', 'articles-index.js?v=' + ts + '"')
            new_content = new_content.replace("articles-index.js'", "articles-index.js?v=" + ts + "'")
        if new_content != content:
            with sftp.open(fpath, "w") as f:
                f.write(new_content.encode("utf-8"))
            print(f"[OK] {fname}: updated to v={ts}")
        else:
            print(f"[SKIP] {fname}: no change")
    except FileNotFoundError:
        print(f"[SKIP] {fname}: not found")
    except Exception as e:
        print(f"[ERROR] {fname}: {e}")

print("\nVerify:")
for fname in html_files:
    fpath = SITE_ROOT + "/" + fname
    try:
        with sftp.open(fpath, "r") as f:
            content = f.read().decode("utf-8")
        hits = re.findall(r'articles-index\.js[^"\s>]*', content)
        for h in hits:
            print(f"  {fname}: {h}")
    except:
        pass

sftp.close()
ssh_client.close()
print("\nDone!")
'''

with sftp.open("/tmp/fix_cache2.py", "w") as f:
    f.write(SCRIPT)
sftp.close()

stdin, stdout, stderr = ssh.exec_command(
    "cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 /tmp/fix_cache2.py 2>&1",
    timeout=30
)
print(stdout.read().decode('utf-8', errors='replace'), flush=True)

ssh.close()
