"""检查紧急补齐脚本状态"""
import paramiko
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

def ssh_cmd(cmd, timeout=30):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, PORT, USER, PASS, timeout=10)
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    client.close()
    return out, err

# 检查脚本是否存在
out, _ = ssh_cmd("ls -la ~/Google-Data-Analysis/backend/scripts/emergency_backfill.py 2>/dev/null")
print(f"脚本文件: {out.strip()}")

# 检查进程
out, _ = ssh_cmd("ps aux | grep emergency_backfill | grep -v grep")
print(f"\n进程: {out.strip() if out.strip() else '未运行'}")

# 检查日志
out, _ = ssh_cmd("cat ~/Google-Data-Analysis/backend/logs/emergency_backfill.log 2>/dev/null | tail -50")
print(f"\n日志 (最后50行):\n{out}")

# 如果没有日志，可能脚本没启动成功，手动测试
if not out.strip():
    print("\n=== 手动测试脚本 ===")
    out, err = ssh_cmd(
        "cd ~/Google-Data-Analysis/backend && source venv/bin/activate && python -c 'import scripts.emergency_backfill; print(\"import ok\")' 2>&1",
        timeout=15
    )
    print(f"导入测试: {out.strip()}")
    if err:
        print(f"错误: {err[:500]}")
    
    # 直接运行看报错
    out, err = ssh_cmd(
        "cd ~/Google-Data-Analysis/backend && source venv/bin/activate && python scripts/emergency_backfill.py 2>&1 | head -30",
        timeout=30
    )
    print(f"\n直接运行输出:\n{out}")
    if err:
        print(f"错误: {err[:500]}")
