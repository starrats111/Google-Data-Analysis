import paramiko, sys, time
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

def run(cmd, timeout=30):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace'), stderr.read().decode('utf-8', errors='replace')

PROJECT = "/home/admin/Google-Data-Analysis"

# 1. Pull latest code
print("=== Pull code ===", flush=True)
out, _ = run(f"cd {PROJECT} && git fetch origin && git reset --hard origin/main 2>&1")
print(out.strip(), flush=True)

# 2. Verify fix
print("\n=== Verify fix ===", flush=True)
out, _ = run(f"grep 'domain_name' {PROJECT}/backend/app/api/article_gen.py | head -3")
print(f"Backend domain fallback: {out.strip()}", flush=True)
out, _ = run(f"grep '_buildImageSearchQuery' {PROJECT}/frontend/src/components/PublishWizard/index.jsx | head -2")
print(f"Frontend search builder: {out.strip()}", flush=True)

# 3. AGGRESSIVE kill of ALL uvicorn processes
print("\n=== Kill ALL uvicorn ===", flush=True)
out, _ = run("ps aux | grep uvicorn | grep -v grep")
print(f"Before kill:\n{out.strip()}", flush=True)

run("pkill -9 -f uvicorn 2>/dev/null")
time.sleep(2)
run("fuser -k 8000/tcp 2>/dev/null")
time.sleep(2)
run("lsof -ti:8000 | xargs kill -9 2>/dev/null")
time.sleep(2)

out, _ = run("ps aux | grep uvicorn | grep -v grep")
remaining = out.strip()
if remaining:
    print(f"WARNING: Still running:\n{remaining}", flush=True)
    pids = [line.split()[1] for line in remaining.split('\n') if line.strip()]
    for pid in pids:
        run(f"kill -9 {pid} 2>/dev/null")
    time.sleep(2)
else:
    print("All uvicorn processes killed", flush=True)

# 4. Verify port is free
out, _ = run("ss -tlnp | grep 8000")
port_status = out.strip()
if port_status:
    print(f"WARNING: Port 8000 still in use: {port_status}", flush=True)
else:
    print("Port 8000 is free", flush=True)

# 5. Start new uvicorn
print("\n=== Start uvicorn ===", flush=True)
channel = ssh.get_transport().open_session()
channel.exec_command(
    f"cd {PROJECT}/backend && source venv/bin/activate && "
    f"nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 "
    f"> /home/admin/backend.log 2>&1 &"
)
time.sleep(8)

# 6. Verify it's running
out, _ = run("curl -s http://localhost:8000/health 2>&1")
print(f"Health: {out.strip()}", flush=True)

out, _ = run("ps aux | grep uvicorn | grep -v grep | head -3")
print(f"Processes:\n{out.strip()}", flush=True)

# 7. Check no port conflict in logs
out, _ = run("grep -i 'Errno 98\\|address already in use' /home/admin/backend.log 2>/dev/null | tail -3")
conflict = out.strip()
if conflict:
    print(f"\nWARNING: Port conflict detected:\n{conflict}", flush=True)
else:
    print("\nNo port conflict - clean start!", flush=True)

# 8. Quick test: crawl image search
print("\n=== Test crawl fallback ===", flush=True)
out, _ = run(f"""cd {PROJECT}/backend && source venv/bin/activate && python3 -c "
from app.services.merchant_crawler import search_images
imgs = search_images('AI Travel Planner Smart Luggage', count=5)
print('Images found:', len(imgs))
for i in imgs[:3]:
    print(' ', i[:80])
" 2>&1""", timeout=30)
print(out.strip(), flush=True)

ssh.close()
print("\nDeployment complete!", flush=True)
