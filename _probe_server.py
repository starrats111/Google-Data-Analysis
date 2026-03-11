"""探查服务器结构"""
import paramiko

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

def run(ssh, cmd, timeout=30):
    print(f"\n>>> {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    stdout.channel.recv_exit_status()
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    if out.strip():
        print(out.strip())
    if err.strip():
        print(f"[STDERR] {err.strip()}")
    return out

def main():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, PORT, USER, PASS, timeout=15)
    print("connected")

    run(ssh, "ls -la /home/admin/ | grep -E '^d|google|Google|analysis|backend'")
    run(ssh, "find /home/admin -maxdepth 3 -name 'main.py' -path '*/app/*' 2>/dev/null")
    run(ssh, "find /home/admin -maxdepth 3 -name '.git' -type d 2>/dev/null")
    run(ssh, "find /home/admin -maxdepth 4 -name 'app.db' 2>/dev/null")
    run(ssh, "find /home/admin -maxdepth 3 -name 'venv' -type d 2>/dev/null")
    run(ssh, "ps aux | grep uvicorn | grep -v grep")
    run(ssh, "cat /home/admin/Google-Data-Analysis/backend/app/config.py 2>/dev/null | head -5 || echo 'not found'")
    run(ssh, "ls /home/admin/Google-Data-Analysis/backend/ 2>/dev/null || echo 'dir not found'")
    run(ssh, "ls /home/admin/google-analysis/backend/ 2>/dev/null || echo 'dir not found'")

    ssh.close()

if __name__ == "__main__":
    main()
