"""修复 api/__init__.py 删除 luchu 导入"""
import paramiko

HOST = '47.239.193.33'
USER = 'admin'
PASS = 'A123456'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, port=22, username=USER, password=PASS, timeout=15)

# Read the file
stdin, stdout, stderr = ssh.exec_command("cat /home/admin/Google-Data-Analysis/backend/app/api/__init__.py", timeout=15)
content = stdout.read().decode()
print("=== BEFORE ===")
print(content)

ssh.close()
