import paramiko, sys, time
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

def run(cmd, timeout=30):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace'), stderr.read().decode('utf-8', errors='replace')

PROJECT = "/home/admin/Google-Data-Analysis"

# Pull
print("=== Pull ===", flush=True)
out, _ = run(f"cd {PROJECT} && git fetch origin && git reset --hard origin/main 2>&1")
print(out.strip(), flush=True)

# Restart
print("\n=== Restart ===", flush=True)
run("pkill -9 -f uvicorn 2>/dev/null")
time.sleep(3)
run("fuser -k 8000/tcp 2>/dev/null")
time.sleep(2)
channel = ssh.get_transport().open_session()
channel.exec_command(f"cd {PROJECT}/backend && source venv/bin/activate && nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > /home/admin/backend.log 2>&1 &")
time.sleep(7)
out, _ = run("curl -s http://localhost:8000/health")
print(f"Health: {out}", flush=True)

ssh.close()
print("Done!", flush=True)
