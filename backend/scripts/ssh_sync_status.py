"""检查同步状态和数据完整性"""
import paramiko

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"
DB = "~/Google-Data-Analysis/backend/google_analysis.db"

def ssh_sql(sql, timeout=30):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, PORT, USER, PASS, timeout=10)
    cmd = f'sqlite3 -header -separator "|" {DB} "{sql}"'
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    client.close()
    if err:
        print(f"  ERR: {err.strip()}")
    return out.strip()

# 1. MCC同步状态
print("=== MCC 同步状态 ===")
out = ssh_sql("SELECT id, mcc_name, currency, last_sync_status, last_sync_at, last_sync_date FROM google_mcc_accounts WHERE user_id IN (5,6)")
print(out)

# 2. 每天数据量
print("\n=== wj04/wj05 每天数据量 ===")
out = ssh_sql("SELECT u.username, g.date, COUNT(*) as campaigns, SUM(g.cost) as total_cost FROM google_ads_api_data g JOIN users u ON g.user_id=u.id WHERE u.username IN ('wj04','wj05') AND g.date >= '2026-02-19' GROUP BY u.username, g.date ORDER BY u.username, g.date")
print(out)

# 3. 最新数据日期
print("\n=== 最新数据日期 ===")
out = ssh_sql("SELECT u.username, MAX(g.date) as max_date, MIN(g.date) as min_date, COUNT(DISTINCT g.date) as total_dates FROM google_ads_api_data g JOIN users u ON g.user_id=u.id WHERE u.username IN ('wj04','wj05') GROUP BY u.username")
print(out)

# 4. 检查 scheduler 日志
print("\n=== 最近同步日志 ===")
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, PORT, USER, PASS, timeout=10)
cmd = "tail -50 ~/Google-Data-Analysis/backend/logs/app.log 2>/dev/null | grep -i 'sync\\|error\\|fail' | tail -20"
stdin, stdout, stderr = client.exec_command(cmd, timeout=30)
out = stdout.read().decode('utf-8', errors='replace')
print(out[:2000] if out else "  无日志")

# 5. 检查 nohup.out 中的同步错误
cmd = "tail -200 ~/Google-Data-Analysis/backend/nohup.out 2>/dev/null | grep -i 'sync\\|error\\|quota\\|fail' | tail -20"
stdin, stdout, stderr = client.exec_command(cmd, timeout=30)
out = stdout.read().decode('utf-8', errors='replace')
print("\n=== nohup.out 同步相关 ===")
print(out[:2000] if out else "  无相关日志")

client.close()
