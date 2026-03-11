import paramiko, sys, time, json
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

def run(cmd, timeout=30):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace'), stderr.read().decode('utf-8', errors='replace')

PROJECT = "/home/admin/Google-Data-Analysis"

# Upload sync script
sftp = ssh.open_sftp()
with sftp.open("/tmp/full_resync.py", "w") as f:
    f.write('''
import sys, os, json
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

with open("/tmp/resync_result.json", "w") as out:
    json.dump({"status": "running", "before_total": total_before, "before": {k:v for k,v in before_dict.items()}}, out)

try:
    svc = CampaignLinkSyncService(db)
    result = svc.sync_all_users()

    after = db.query(
        CampaignLinkCache.platform_code,
        func.count(CampaignLinkCache.id),
    ).group_by(CampaignLinkCache.platform_code).all()
    after_dict = dict(after)
    total_after = sum(after_dict.values())

    with open("/tmp/resync_result.json", "w") as out:
        json.dump({
            "status": "done",
            "before_total": total_before,
            "after_total": total_after,
            "diff": total_after - total_before,
            "before": {k:v for k,v in before_dict.items()},
            "after": {k:v for k,v in after_dict.items()},
            "sync_result": {
                "total_users": result.get("total_users"),
                "total_cached": result.get("total_cached"),
                "total_errors": result.get("total_errors"),
            }
        }, out)
except Exception as e:
    with open("/tmp/resync_result.json", "w") as out:
        json.dump({"status": "error", "error": str(e)}, out)
finally:
    db.close()
''')
sftp.close()
print("Script uploaded", flush=True)

# Launch background process without waiting for stdout
channel = ssh.get_transport().open_session()
channel.exec_command(f"cd {PROJECT}/backend && source venv/bin/activate && python3 /tmp/full_resync.py > /tmp/resync_log.txt 2>&1")
print("Background sync launched on server", flush=True)

# Don't read channel output - just poll the result file
time.sleep(5)

for i in range(60):
    time.sleep(30)
    try:
        ssh2 = paramiko.SSHClient()
        ssh2.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh2.connect("47.239.193.33", username="admin", password="A123456", timeout=10)
        stdin, stdout, stderr = ssh2.exec_command("cat /tmp/resync_result.json 2>/dev/null", timeout=15)
        out = stdout.read().decode('utf-8', errors='replace').strip()
        ssh2.close()
        
        if out:
            data = json.loads(out)
            status = data.get("status", "unknown")
            elapsed = (i+1)*30
            print(f"[{elapsed}s] Status: {status}", flush=True)
            if status == "done":
                print(f"  Before: {data['before_total']}", flush=True)
                print(f"  After:  {data['after_total']} (+{data['diff']})", flush=True)
                sr = data.get('sync_result', {})
                print(f"  Sync:   users={sr.get('total_users')}, cached={sr.get('total_cached')}, errors={sr.get('total_errors')}", flush=True)
                before = data.get('before', {})
                after = data.get('after', {})
                all_keys = sorted(set(list(before.keys()) + list(after.keys())))
                for k in all_keys:
                    b = before.get(k, 0)
                    a = after.get(k, 0)
                    d = a - b
                    print(f"    {k}: {b} -> {a} ({'+' if d >= 0 else ''}{d})", flush=True)
                break
            elif status == "error":
                print(f"  Error: {data.get('error', 'unknown')}", flush=True)
                break
            elif status == "running":
                print(f"  Before total: {data.get('before_total', '?')}", flush=True)
        else:
            print(f"[{(i+1)*30}s] Not started yet...", flush=True)
    except Exception as e:
        print(f"[{(i+1)*30}s] Poll error: {e}", flush=True)

# Show server log
try:
    ssh3 = paramiko.SSHClient()
    ssh3.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh3.connect("47.239.193.33", username="admin", password="A123456", timeout=10)
    stdin, stdout, stderr = ssh3.exec_command("tail -30 /tmp/resync_log.txt 2>/dev/null", timeout=15)
    log = stdout.read().decode('utf-8', errors='replace')
    ssh3.close()
    print(f"\n=== Server log ===\n{log}", flush=True)
except:
    pass

print("Done.", flush=True)
