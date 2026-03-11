"""Find backend path on server"""
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')
pkey = paramiko.RSAKey.from_private_key_file(r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem")
bt = paramiko.SSHClient()
bt.set_missing_host_key_policy(paramiko.AutoAddPolicy())
bt.connect("52.74.221.116", 22, "ubuntu", pkey=pkey, timeout=15)
def r(cmd, t=15):
    stdin, stdout, stderr = bt.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

# Broad search
print("Search 1: find processes")
print(r("ps aux | grep -i 'uvicorn\\|gunicorn\\|fastapi\\|python.*main' | grep -v grep"))

print("\nSearch 2: find supervisor configs")
print(r("cat /etc/supervisor/conf.d/*.conf 2>/dev/null || ls /etc/supervisor/conf.d/ 2>/dev/null"))

print("\nSearch 3: systemd services")
print(r("systemctl list-units --type=service | grep -i 'backend\\|google\\|api\\|analysis' 2>/dev/null"))

print("\nSearch 4: find main.py or app directory")
print(r("find / -maxdepth 5 -name 'main.py' -path '*backend*' 2>/dev/null | head -5"))

print("\nSearch 5: find .env files")
print(r("find / -maxdepth 5 -name '.env' -path '*backend*' 2>/dev/null | head -5"))
print(r("find / -maxdepth 5 -name '.env' -path '*google*' 2>/dev/null | head -5"))

print("\nSearch 6: docker")
print(r("docker ps 2>/dev/null | head -5"))

print("\nSearch 7: www root listing")
print(r("ls /www/wwwroot/ 2>/dev/null"))

bt.close()
