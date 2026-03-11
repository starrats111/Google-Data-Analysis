"""CR-040 restart only"""
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

    BE_DIR = "/home/admin/Google-Data-Analysis/backend"

    # kill everything on port 8000
    run(ssh, "fuser -k 8000/tcp 2>/dev/null || true")
    run(ssh, "kill -9 $(pgrep -f 'uvicorn') 2>/dev/null || true")
    time.sleep(5)
    run(ssh, "ss -tlnp | grep 8000 || echo 'port 8000 free'")

    # start
    start_cmd = f"cd {BE_DIR} && source venv/bin/activate && nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 > /home/admin/backend.log 2>&1 &"
    print(f"\n>>> starting...")
    ssh.exec_command(f"bash -c '{start_cmd}'")
    time.sleep(8)

    run(ssh, "ps aux | grep uvicorn | grep -v grep | head -5")
    run(ssh, "curl -s --max-time 10 http://localhost:8000/api/health || echo 'FAIL'")
    run(ssh, "tail -40 /home/admin/backend.log")

    print("\nDone!")
    ssh.close()

if __name__ == "__main__":
    main()
