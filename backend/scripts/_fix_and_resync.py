import paramiko
import sys
import time

sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

def ssh_cmd(ssh, cmd, timeout=300):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace'), stderr.read().decode('utf-8', errors='replace')

PROJECT = "/home/admin/Google-Data-Analysis"

# 1. Force deploy latest code
print("=== Force deploy ===")
out, _ = ssh_cmd(ssh, f"cd {PROJECT} && git fetch origin && git reset --hard origin/main 2>&1")
print(out)

# 2. Verify LH config
print("=== Verify LH config ===")
out, _ = ssh_cmd(ssh, f"grep -A5 '\"LH\"' {PROJECT}/backend/app/services/merchant_platform_sync.py | head -8")
print(out)

# 3. Restart backend
print("=== Restart ===")
ssh_cmd(ssh, "pkill -9 -f uvicorn 2>/dev/null; sleep 1; fuser -k 8000/tcp 2>/dev/null; sleep 2")
transport = ssh.get_transport()
channel = transport.open_session()
channel.exec_command(f"cd {PROJECT}/backend && source venv/bin/activate && PYTHONUNBUFFERED=1 nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > /home/admin/backend.log 2>&1 &")
time.sleep(6)
out, _ = ssh_cmd(ssh, "curl -s http://localhost:8000/health")
print(f"Health: {out}")

# 4. Run full resync
print("\n=== Full resync ===")
sftp = ssh.open_sftp()
with sftp.open("/tmp/resync_v3.py", "w") as f:
    f.write('''
import sys, os
sys.path.insert(0, "/home/admin/Google-Data-Analysis/backend")
os.chdir("/home/admin/Google-Data-Analysis/backend")

from sqlalchemy import func
from app.database import SessionLocal
from app.models.campaign_link_cache import CampaignLinkCache
from app.services.campaign_link_sync_service import CampaignLinkSyncService

db = SessionLocal()

before = db.query(
    CampaignLinkCache.platform_code,
    func.count(CampaignLinkCache.id),
).group_by(CampaignLinkCache.platform_code).all()
before_dict = dict(before)
total_before = sum(before_dict.values())
print(f"Before: {total_before} total")
for pc in sorted(before_dict):
    print(f"  {pc}: {before_dict[pc]}")

svc = CampaignLinkSyncService(db)
result = svc.sync_all_users()
print(f"\\nSync done: users={result['total_users']} cached={result['total_cached']} errors={result['total_errors']}")

after = db.query(
    CampaignLinkCache.platform_code,
    func.count(CampaignLinkCache.id),
).group_by(CampaignLinkCache.platform_code).all()
after_dict = dict(after)
total_after = sum(after_dict.values())
print(f"\\nAfter: {total_after} total (+{total_after - total_before})")
for pc in sorted(after_dict):
    old = before_dict.get(pc, 0)
    diff = after_dict[pc] - old
    print(f"  {pc}: {after_dict[pc]} ({'+' if diff >= 0 else ''}{diff})")

db.close()
''')
sftp.close()

out, _ = ssh_cmd(ssh, f"cd {PROJECT}/backend && source venv/bin/activate && python3 /tmp/resync_v3.py 2>&1", timeout=900)
print(out[-2000:])

ssh.close()
