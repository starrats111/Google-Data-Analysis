"""Quick health check"""
import paramiko, sys, time
sys.stdout.reconfigure(encoding='utf-8')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', 22, 'admin', password='A123456', timeout=15)

for i in range(3):
    time.sleep(3)
    stdin, stdout, stderr = ssh.exec_command('curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health', timeout=10)
    stdout.channel.recv_exit_status()
    code = stdout.read().decode().strip()
    print(f"Attempt {i+1}: {code}")
    if code == "200":
        break

# Check logs for errors
stdin, stdout, stderr = ssh.exec_command('tail -20 /home/admin/backend.log', timeout=10)
stdout.channel.recv_exit_status()
print("\nRecent logs:")
print(stdout.read().decode('utf-8', errors='replace'))

ssh.close()
