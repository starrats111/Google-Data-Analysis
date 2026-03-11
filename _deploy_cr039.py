"""CR-039 deploy to server"""
import paramiko, time

HOST = "47.239.193.33"
USER = "admin"
PASS = "A123456"

def run(ssh, cmd, timeout=60):
    print(f"\n>>> {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    stdout.channel.recv_exit_status()
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    if out.strip(): print(out.strip()[-3000:])
    if err.strip(): print(f"[STDERR] {err.strip()[-1000:]}")
    return out

def upload_file(sftp, local, remote):
    print(f"  upload: {local} -> {remote}")
    sftp.put(local, remote)

def main():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, 22, USER, PASS, timeout=15)
    sftp = ssh.open_sftp()
    print("connected")

    BE = "/home/admin/Google-Data-Analysis/backend"

    # 1. Upload new files
    new_files = {
        r"d:\Google Analysis\backend\app\api\ad_creation.py": f"{BE}/app/api/ad_creation.py",
        r"d:\Google Analysis\backend\app\services\ad_copy_generator.py": f"{BE}/app/services/ad_copy_generator.py",
        r"d:\Google Analysis\backend\app\services\google_ads_client_factory.py": f"{BE}/app/services/google_ads_client_factory.py",
        r"d:\Google Analysis\backend\app\services\google_ads_creator.py": f"{BE}/app/services/google_ads_creator.py",
        r"d:\Google Analysis\backend\app\services\keyword_plan_service.py": f"{BE}/app/services/keyword_plan_service.py",
    }
    modified_files = {
        r"d:\Google Analysis\backend\app\api\merchants.py": f"{BE}/app/api/merchants.py",
        r"d:\Google Analysis\backend\app\main.py": f"{BE}/app/main.py",
        r"d:\Google Analysis\backend\app\models\merchant.py": f"{BE}/app/models/merchant.py",
    }

    print("\n--- Uploading new files ---")
    for local, remote in new_files.items():
        upload_file(sftp, local, remote)

    print("\n--- Uploading modified files ---")
    for local, remote in modified_files.items():
        upload_file(sftp, local, remote)

    # 2. DB migration
    run(ssh, f"""cd {BE} && source venv/bin/activate && python3 << 'PYEOF'
import sqlite3
conn = sqlite3.connect('google_analysis.db')
c = conn.cursor()
c.execute('PRAGMA table_info(merchant_assignments)')
cols = [r[1] for r in c.fetchall()]
new_cols = [
    ('mode', "VARCHAR(20) DEFAULT 'normal'"),
    ('assignment_source', "VARCHAR(20) DEFAULT 'manager_assign'"),
    ('google_campaign_id', 'VARCHAR(50)'),
    ('google_customer_id', 'VARCHAR(20)'),
    ('daily_budget', 'REAL'),
    ('target_country', "VARCHAR(10) DEFAULT 'US'"),
]
for col_name, col_type in new_cols:
    if col_name not in cols:
        c.execute('ALTER TABLE merchant_assignments ADD COLUMN %s %s' % (col_name, col_type))
        print('ADDED ' + col_name)
    else:
        print(col_name + ' EXISTS')
conn.commit()
conn.close()
PYEOF
""")

    # 3. Restart
    run(ssh, "fuser -k 8000/tcp 2>/dev/null || true")
    run(ssh, "kill -9 $(pgrep -f 'uvicorn') 2>/dev/null || true")
    time.sleep(5)

    start_cmd = f"cd {BE} && source venv/bin/activate && nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 > /home/admin/backend.log 2>&1 &"
    print(f"\n>>> starting uvicorn...")
    ssh.exec_command(f"bash -c '{start_cmd}'")
    time.sleep(8)

    # 4. Verify
    run(ssh, "ps aux | grep uvicorn | grep -v grep | head -3")
    run(ssh, "curl -s --max-time 10 http://localhost:8000/api/ad-creation/mcc-accounts 2>&1 | head -1 || echo 'endpoint check...'")
    run(ssh, "tail -30 /home/admin/backend.log")

    sftp.close()
    ssh.close()
    print("\nDeploy done!")

if __name__ == "__main__":
    main()
