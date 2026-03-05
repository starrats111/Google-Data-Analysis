"""检查所有 API Key 配置"""
import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

stdin, stdout, stderr = ssh.exec_command('grep -i "api_key\\|base_url\\|model" /home/admin/Google-Data-Analysis/backend/.env 2>/dev/null')
print(stdout.read().decode())

ssh.close()
