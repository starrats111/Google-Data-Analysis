"""通过SSH连接服务器，直接查询数据库对比 wj04/wj05 数据差异"""
import paramiko
import json

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

def ssh_exec(cmd, timeout=30):
    """执行SSH命令"""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, PORT, USER, PASS, timeout=10)
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    client.close()
    return out, err

# 测试连接
print("=== 测试SSH连接 ===")
out, err = ssh_exec("echo connected && whoami")
print(f"  {out.strip()}")

# 查看数据库位置
print("\n=== 查找数据库 ===")
out, err = ssh_exec("ls -la ~/Google-Data-Analysis/backend/google_analysis.db 2>/dev/null || find ~/Google-Data-Analysis -name '*.db' 2>/dev/null")
print(f"  {out.strip()}")

# 查看数据库表结构
print("\n=== 数据库表结构 ===")
out, err = ssh_exec("cd ~/Google-Data-Analysis/backend && sqlite3 google_analysis.db 'PRAGMA table_info(google_ads_api_data);'")
print(f"  {out.strip()}")

# 查看 MCC 表是否有 currency
print("\n=== MCC 表结构 ===")
out, err = ssh_exec("cd ~/Google-Data-Analysis/backend && sqlite3 google_analysis.db 'PRAGMA table_info(google_mcc_accounts);'")
print(f"  {out.strip()}")
