"""验证 OPT-010 部署状态"""
import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

# 检查 uvicorn 进程
stdin, stdout, stderr = ssh.exec_command('ps aux | grep uvicorn | grep -v grep')
result = stdout.read().decode()
print("=== Uvicorn Processes ===")
print(result if result.strip() else "No uvicorn processes found!")

# 健康检查
stdin, stdout, stderr = ssh.exec_command('curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health')
code = stdout.read().decode().strip()
print(f"Health check: {code}")

# 检查新文件是否存在
stdin, stdout, stderr = ssh.exec_command('ls -la /home/admin/Google-Data-Analysis/backend/app/services/anomaly_detection.py /home/admin/Google-Data-Analysis/backend/app/services/claude_analysis_service.py /home/admin/Google-Data-Analysis/backend/app/services/cpa_diagnostics.py /home/admin/Google-Data-Analysis/backend/excel/l7d_claude_prompt.txt 2>&1')
print("\n=== New OPT-010 Files ===")
print(stdout.read().decode())

# 检查最近日志
stdin, stdout, stderr = ssh.exec_command('tail -15 /home/admin/backend.log')
print("=== Recent Backend Logs ===")
print(stdout.read().decode())

if "uvicorn" in result and code == "200":
    print("\n✅ OPT-010 部署验证成功！")
else:
    print(f"\n⚠️ 状态异常 (processes: {'有' if result.strip() else '无'}, health: {code})")

ssh.close()
