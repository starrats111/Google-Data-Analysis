import paramiko, sys, time
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

def run(cmd, timeout=60):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace'), stderr.read().decode('utf-8', errors='replace')

PROJECT = "/home/admin/Google-Data-Analysis"

# Upload sync script to server
sftp = ssh.open_sftp()
with sftp.open("/tmp/full_resync.py", "w") as f:
    f.write('''
import sys, os, json, time
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
    json.dump({"status": "started", "before_total": total_before, "before": {k:v for k,v in before_dict.items()}}, out)

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
print("Script uploaded")

# Run it in background on the server using nohup
run(f"cd {PROJECT}/backend && source venv/bin/activate && nohup python3 /tmp/full_resync.py > /tmp/resync_log.txt 2>&1 &")
print("Background sync started on server")

# Poll for completion
for i in range(60):
    time.sleep(30)
    try:
        out, _ = run("cat /tmp/resync_result.json 2>/dev/null")
        if out.strip():
            import json
            data = json.loads(out.strip())
            status = data.get("status", "unknown")
            print(f"[{(i+1)*30}s] Status: {status}")
            if status == "done":
                print(f"  Before: {data['before_total']}")
                print(f"  After:  {data['after_total']} (+{data['diff']})")
                print(f"  Sync:   users={data['sync_result']['total_users']}, cached={data['sync_result']['total_cached']}, errors={data['sync_result']['total_errors']}")
                before = data.get('before', {})
                after = data.get('after', {})
                all_keys = sorted(set(list(before.keys()) + list(after.keys())))
                for k in all_keys:
                    b = before.get(k, 0)
                    a = after.get(k, 0)
                    d = a - b
                    print(f"    {k}: {b} -> {a} ({'+' if d >= 0 else ''}{d})")
                break
            elif status == "error":
                print(f"  Error: {data.get('error', 'unknown')}")
                break
        else:
            print(f"[{(i+1)*30}s] Still running...")
    except Exception as e:
        print(f"[{(i+1)*30}s] Poll error: {e}")

# Show log tail
out, _ = run("tail -50 /tmp/resync_log.txt 2>/dev/null")
print(f"\n=== Server log tail ===\n{out}")

ssh.close()
