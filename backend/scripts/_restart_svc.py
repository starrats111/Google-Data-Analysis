"""用正确的 venv 路径重启 uvicorn 并验证"""
import paramiko
import time

HOST = "47.239.193.33"
USER = "admin"
PASS = "A123456"
PROJECT = "/home/admin/Google-Data-Analysis"
VENV = f"{PROJECT}/backend/venv"

def ssh_exec(ssh, cmd, timeout=60):
    print(f"  > {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace")
    if out.strip():
        print(out.strip()[:3000])
    if err.strip():
        print(f"  [stderr] {err.strip()[:1000]}")
    return out, err

def main():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, username=USER, password=PASS, timeout=15)
    print("=== Connected ===")

    # Kill old processes
    print("\n--- 1. Kill old uvicorn ---")
    ssh_exec(ssh, "pkill -9 -f uvicorn || true")
    time.sleep(2)
    ssh_exec(ssh, "fuser -k 8000/tcp 2>/dev/null || true")
    time.sleep(1)

    # Restart with correct venv
    print("\n--- 2. Restart uvicorn ---")
    restart_cmd = (
        f"cd {PROJECT}/backend && "
        f"source {VENV}/bin/activate && "
        f"nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 "
        f"--workers 2 --timeout-keep-alive 120 "
        f"> {PROJECT}/nohup.out 2>&1 &"
    )
    ssh_exec(ssh, restart_cmd)
    time.sleep(6)

    # Health check
    print("\n--- 3. Health check ---")
    out, _ = ssh_exec(ssh, "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/api/health")
    if "200" in out:
        print("  ✓ Server is UP")
    else:
        print("  ✗ Server may not be ready, checking logs...")
        ssh_exec(ssh, f"tail -30 {PROJECT}/nohup.out")

    # Verify config loaded
    print("\n--- 4. Verify config on server ---")
    test_script = f"""
import sys
sys.path.insert(0, '{PROJECT}/backend')
from app.services.merchant_platform_sync import PLATFORM_API_CONFIG
lb = PLATFORM_API_CONFIG.get("LB", {{}})
print(f"LB: mode={{lb.get('mode')}}, extra_params={{lb.get('extra_params')}}")
lh = PLATFORM_API_CONFIG.get("LH", {{}})
print(f"LH: mode={{lh.get('mode')}}")
"""
    sftp = ssh.open_sftp()
    with sftp.file("/tmp/_verify_config.py", "w") as f:
        f.write(test_script)
    sftp.close()
    ssh_exec(ssh, f"source {VENV}/bin/activate && python /tmp/_verify_config.py")

    print("\n=== Done ===")
    ssh.close()

if __name__ == "__main__":
    main()
