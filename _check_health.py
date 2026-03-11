"""check health"""
import paramiko, time

def run(ssh, cmd, timeout=30):
    print(f"\n>>> {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    stdout.channel.recv_exit_status()
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    if out.strip(): print(out.strip()[-3000:])
    if err.strip(): print(f"[STDERR] {err.strip()[-1000:]}")
    return out

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", 22, "admin", "A123456", timeout=15)
print("connected")

run(ssh, "ps aux | grep uvicorn | grep -v grep")
run(ssh, "curl -s --max-time 15 http://localhost:8000/api/health || echo 'FAIL'")
run(ssh, "tail -50 /home/admin/backend.log")
ssh.close()
