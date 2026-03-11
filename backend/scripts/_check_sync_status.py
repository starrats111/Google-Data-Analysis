import paramiko, sys, time
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

def run(cmd, timeout=30):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace'), stderr.read().decode('utf-8', errors='replace')

PROJECT = "/home/admin/Google-Data-Analysis"

# 1. Backend health
print("=== Backend Health ===", flush=True)
out, _ = run("curl -s http://localhost:8000/health")
print(out, flush=True)

# 2. Check if sync process is running
print("=== Sync Process ===", flush=True)
out, _ = run("ps aux | grep -i 'sync\\|campaign' | grep -v grep")
print(out if out.strip() else "(no sync process running)", flush=True)

# 3. Check sync result file
print("=== Sync Result File ===", flush=True)
out, _ = run("ls -la /tmp/sync_result* /tmp/full_sync* 2>/dev/null")
print(out if out.strip() else "(no result files)", flush=True)
out, _ = run("cat /tmp/sync_result.txt 2>/dev/null || cat /tmp/full_sync_result.txt 2>/dev/null || echo '(no result file)'")
print(out[:2000], flush=True)

# 4. Check campaign_link_cache table stats
print("=== Cache Stats ===", flush=True)
out, _ = run(f"""cd {PROJECT}/backend && source venv/bin/activate && python3 -c "
from app.database import SessionLocal
from sqlalchemy import text
db = SessionLocal()
total = db.execute(text('SELECT COUNT(*) FROM campaign_link_cache')).scalar()
users = db.execute(text('SELECT user_id, COUNT(*) as cnt FROM campaign_link_cache GROUP BY user_id ORDER BY user_id')).fetchall()
print(f'Total cached: {{total}}')
for u in users:
    print(f'  user_id={{u[0]}}: {{u[1]}} links')
db.close()
" 2>&1""")
print(out, flush=True)

# 5. Check scheduler status
print("=== Scheduler ===", flush=True)
out, _ = run(f"""cd {PROJECT}/backend && source venv/bin/activate && python3 -c "
from app.database import SessionLocal
from sqlalchemy import text
db = SessionLocal()
try:
    jobs = db.execute(text('SELECT * FROM apscheduler_jobs')).fetchall()
    print(f'Scheduled jobs: {{len(jobs)}}')
    for j in jobs:
        print(f'  {{j}}')
except Exception as e:
    print(f'No scheduler table or error: {{e}}')
db.close()
" 2>&1""")
print(out, flush=True)

# 6. Recent backend logs about sync
print("=== Recent Sync Logs ===", flush=True)
out, _ = run("grep -i 'sync\\|campaign.*cache\\|scheduler\\|定时' /home/admin/backend.log 2>/dev/null | tail -30")
print(out[-2000:] if out.strip() else "(no sync logs)", flush=True)

# 7. Check pending todos - LH platform fix
print("=== LH Platform Config ===", flush=True)
out, _ = run(f"""cd {PROJECT}/backend && source venv/bin/activate && python3 -c "
from app.services.merchant_platform_sync import PLATFORM_CONFIG
for name, cfg in PLATFORM_CONFIG.items():
    print(f'{{name}}: mode={{cfg.get(\"mode\")}}, max_size={{cfg.get(\"max_size\")}}, base={{cfg.get(\"base_url\",\"\")[:50]}}')
" 2>&1""")
print(out, flush=True)

ssh.close()
print("Done!", flush=True)
