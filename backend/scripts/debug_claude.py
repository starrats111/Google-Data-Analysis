"""排查 Claude API 连接问题"""
import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

# 1. 检查 .env 中的 CLAUDE 配置
print("=== .env Claude Config ===")
stdin, stdout, stderr = ssh.exec_command('grep -i claude /home/admin/Google-Data-Analysis/backend/.env 2>/dev/null || echo "NO CLAUDE CONFIG FOUND"')
print(stdout.read().decode())

# 2. 检查 config.py 中的默认值
print("=== config.py Claude Config ===")
stdin, stdout, stderr = ssh.exec_command('grep -A5 -i claude /home/admin/Google-Data-Analysis/backend/app/config.py 2>/dev/null')
print(stdout.read().decode())

# 3. 检查后端日志中的 Claude 错误
print("=== Backend Log (Claude errors) ===")
stdin, stdout, stderr = ssh.exec_command('grep -i "claude\\|OPT-010\\|anthropic" /home/admin/backend.log 2>/dev/null | tail -20')
result = stdout.read().decode()
print(result if result.strip() else "No Claude-related log entries found")

# 4. 测试 anthropic 包版本
print("\n=== Anthropic Package ===")
stdin, stdout, stderr = ssh.exec_command('cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python -c "import anthropic; print(anthropic.__version__)"')
print(stdout.read().decode())

ssh.close()
