"""Check backend startup logs"""
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=20)
def run(cmd, t=15):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

print("=== Backend log (last 30 lines) ===")
print(run("tail -30 /home/admin/backend.log"))

print("\n=== uvicorn processes ===")
print(run("ps aux | grep uvicorn | grep -v grep"))

print("\n=== Port 8000 ===")
print(run("ss -tlnp | grep 8000"))

ssh.close()
