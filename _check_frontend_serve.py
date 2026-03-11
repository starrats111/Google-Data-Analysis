import paramiko
import time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

# 1. 检查前端是怎么被 serve 的
print("=== Nginx 配置 ===")
stdin, stdout, stderr = ssh.exec_command("cat /etc/nginx/sites-enabled/* 2>/dev/null; cat /www/server/panel/vhost/nginx/*.conf 2>/dev/null | head -100")
out = stdout.read().decode()
print(out[:3000] if out else "(empty)")

# 2. 检查宝塔面板的网站配置
print("\n=== 宝塔 Nginx 配置 ===")
stdin, stdout, stderr = ssh.exec_command("ls /www/server/panel/vhost/nginx/ 2>/dev/null")
print(stdout.read().decode())

# 3. 检查前端 dist 目录
print("=== 前端 dist 目录 ===")
stdin, stdout, stderr = ssh.exec_command("ls -la /home/admin/Google-Data-Analysis/frontend/dist/ | head -10")
print(stdout.read().decode())

# 4. 检查 Nginx 主配置
print("=== Nginx 主配置 ===")
stdin, stdout, stderr = ssh.exec_command("nginx -T 2>/dev/null | grep -A5 'server_name\\|root\\|location.*/' | head -60")
print(stdout.read().decode()[:2000])

# 5. 检查前端是否通过 API 代理
print("=== 检查 API 服务是否也 serve 前端 ===")
stdin, stdout, stderr = ssh.exec_command("grep -r 'StaticFiles\\|mount.*static\\|dist' /home/admin/Google-Data-Analysis/backend/app/main.py 2>/dev/null")
print(stdout.read().decode())

ssh.close()
