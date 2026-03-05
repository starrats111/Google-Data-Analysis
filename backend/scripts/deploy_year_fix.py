import paramiko, time

HOST = '47.239.193.33'
USER = 'admin'
PASS = 'A123456'

def run(desc, cmd, timeout=30, retries=3):
    print(f"\n[{desc}]")
    for attempt in range(retries):
        try:
            ssh = paramiko.SSHClient()
            ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            ssh.connect(HOST, port=22, username=USER, password=PASS, timeout=15, banner_timeout=30)
            stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
            out = stdout.read().decode().strip()
            err = stderr.read().decode().strip()
            if out: print(out)
            if err: print(f"STDERR: {err}")
            if not out and not err: print("(ok)")
            ssh.close()
            return out
        except Exception as e:
            print(f"  Attempt {attempt+1} failed: {e}")
            time.sleep(3)
    return ""

# Read local file content to push to server
with open(r"d:\Google Analysis\backend\app\services\article_gen_service.py", "r", encoding="utf-8") as f:
    content = f.read()

# Write file to server via heredoc
import base64
b64 = base64.b64encode(content.encode("utf-8")).decode("ascii")

run("Upload updated file",
    f"echo '{b64}' | base64 -d > /home/admin/Google-Data-Analysis/backend/app/services/article_gen_service.py")

run("Verify year logic",
    "grep -n 'current_year' /home/admin/Google-Data-Analysis/backend/app/services/article_gen_service.py")

# Restart backend
run("Kill old process", "pkill -9 -f uvicorn; sleep 2; echo done")
time.sleep(2)

run("Start backend",
    "cd /home/admin/Google-Data-Analysis/backend; "
    "source venv/bin/activate; "
    "nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1 > /tmp/backend.log 2>&1 &")

print("\n[Wait 8s...]")
time.sleep(8)

result = run("Health check", "curl -s -m 10 http://127.0.0.1:8000/health")
print(f"\nResult: {'OK' if 'ok' in (result or '') else 'FAIL'}")
