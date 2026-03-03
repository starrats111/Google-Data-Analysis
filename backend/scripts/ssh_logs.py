"""获取同步日志"""
import paramiko
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, PORT, USER, PASS, timeout=10)

# 检查同步日志
cmds = [
    ("最近同步日志", "grep -i 'sync' ~/Google-Data-Analysis/backend/logs/app.log 2>/dev/null | tail -30"),
    ("同步错误", "grep -i 'error\\|fail\\|quota' ~/Google-Data-Analysis/backend/logs/error.log 2>/dev/null | tail -20"),
    ("scheduler状态", "grep -i 'scheduler\\|job\\|cron' ~/Google-Data-Analysis/backend/logs/app.log 2>/dev/null | tail -10"),
    ("nohup同步", "grep -i 'sync_google\\|backfill' ~/Google-Data-Analysis/backend/nohup.out 2>/dev/null | tail -20"),
]

for title, cmd in cmds:
    print(f"\n=== {title} ===")
    stdin, stdout, stderr = client.exec_command(cmd, timeout=30)
    out = stdout.read().decode('utf-8', errors='replace')
    print(out[:3000] if out else "  (empty)")

client.close()
