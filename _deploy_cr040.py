"""CR-040 deploy v4 - fix git stash + kill old process"""
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

def main():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, 22, USER, PASS, timeout=15)
    print("connected")

    GIT_DIR = "/home/admin/Google-Data-Analysis"
    BE_DIR = f"{GIT_DIR}/backend"

    # 1. stash local changes then pull
    run(ssh, f"cd {GIT_DIR} && git stash && git pull origin main")

    # 2. sync app code to runtime dir
    run(ssh, f"rsync -a --delete --exclude='venv' --exclude='*.db' --exclude='*.db-*' --exclude='uploads' --exclude='logs' --exclude='__pycache__' {BE_DIR}/app/ /home/admin/google-analysis/backend/app/")
    # also sync the new image_cache_service
    run(ssh, "ls /home/admin/google-analysis/backend/app/services/image_cache_service.py")

    # 3. cache dir in both locations
    run(ssh, f"mkdir -p {BE_DIR}/uploads/image_cache")
    run(ssh, "mkdir -p /home/admin/google-analysis/backend/uploads/image_cache")

    # 4. kill ALL uvicorn processes
    run(ssh, "kill -9 $(pgrep -f 'uvicorn') 2>/dev/null || true")
    time.sleep(3)
    run(ssh, "ps aux | grep uvicorn | grep -v grep || echo 'all killed'")

    # 5. start fresh from GIT_DIR (with venv)
    start_cmd = f"cd {BE_DIR} && source venv/bin/activate && nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 > /home/admin/backend.log 2>&1 &"
    print(f"\n>>> (bg) starting uvicorn...")
    ssh.exec_command(f"bash -c '{start_cmd}'")
    time.sleep(8)

    # 6. verify
    run(ssh, "ps aux | grep uvicorn | grep -v grep | head -3")
    run(ssh, "curl -s --max-time 10 http://localhost:8000/api/health || echo 'FAIL'")
    run(ssh, "tail -30 /home/admin/backend.log")

    print("\nDeploy done!")
    ssh.close()

if __name__ == "__main__":
    main()
