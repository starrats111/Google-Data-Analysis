"""Deploy: git pull + rebuild frontend + restart backend"""
import paramiko, time, sys
sys.stdout.reconfigure(encoding='utf-8')

# Backend server (password auth)
be = paramiko.SSHClient()
be.set_missing_host_key_policy(paramiko.AutoAddPolicy())
be.connect("47.239.193.33", 22, "admin", password="A123456", timeout=15)
def run_be(cmd, t=30):
    stdin, stdout, stderr = be.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

proj = "/home/admin/Google-Data-Analysis"

# 1. Git pull
print("=== Git Pull ===")
print(run_be(f"cd {proj} && git pull"))

# 2. Rebuild frontend
print("\n=== Build Frontend ===")
print(run_be(f"cd {proj}/frontend && npm run build 2>&1 | tail -5", t=120))

# 3. Restart backend
print("\n=== Restart Backend ===")
restart_cmd = f"""cd {proj}/backend && pkill -f 'uvicorn app.main:app' 2>/dev/null; sleep 1; nohup /home/admin/.local/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 > /tmp/backend.log 2>&1 & echo 'Backend started'"""
print(run_be(restart_cmd))

time.sleep(3)

# 4. Health check
print("\n=== Health Check ===")
print(run_be(f"curl -s -o /dev/null -w '%{{http_code}}' http://localhost:8000/api/health 2>/dev/null || echo 'checking...'"))
time.sleep(2)
print(run_be(f"curl -s -o /dev/null -w '%{{http_code}}' http://localhost:8000/api/health 2>/dev/null || echo 'still starting...'"))

be.close()
print("\n✅ Deploy complete!")
