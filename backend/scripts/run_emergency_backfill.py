"""通过 SSH 上传并执行紧急补齐脚本"""
import paramiko
import sys
import time

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

def ssh_cmd(cmd, timeout=600):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, PORT, USER, PASS, timeout=10)
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    client.close()
    return out, err

# 1. 上传脚本
print("=== 上传脚本到服务器 ===")
with open(r"D:\Google Analysis\backend\scripts\emergency_backfill.py", "r", encoding="utf-8") as f:
    script_content = f.read()

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, PORT, USER, PASS, timeout=10)

sftp = client.open_sftp()
remote_path = "/home/admin/Google-Data-Analysis/backend/scripts/emergency_backfill.py"
# 确保目录存在
try:
    sftp.mkdir("/home/admin/Google-Data-Analysis/backend/scripts")
except:
    pass
with sftp.open(remote_path, "w") as f:
    f.write(script_content)
sftp.close()
client.close()
print(f"  已上传到 {remote_path}")

# 2. 验证脚本存在
out, err = ssh_cmd(f"ls -la {remote_path}")
print(f"  {out.strip()}")

# 3. 在后台执行脚本 (nohup)
print("\n=== 在服务器后台执行补齐脚本 ===")
bg_cmd = (
    f"cd ~/Google-Data-Analysis/backend && "
    f"source venv/bin/activate && "
    f"nohup python scripts/emergency_backfill.py "
    f"> logs/emergency_backfill.log 2>&1 &"
)
out, err = ssh_cmd(bg_cmd)
print(f"  已启动后台任务")
if err:
    print(f"  stderr: {err[:500]}")

# 4. 等几秒看看日志
time.sleep(5)
print("\n=== 初始日志 (前30行) ===")
out, err = ssh_cmd("head -30 ~/Google-Data-Analysis/backend/logs/emergency_backfill.log 2>/dev/null")
print(out)

# 5. 检查进程是否在运行
out, err = ssh_cmd("ps aux | grep emergency_backfill | grep -v grep")
print(f"\n=== 进程状态 ===")
print(out if out.strip() else "  (进程未找到，可能已完成或启动失败)")
