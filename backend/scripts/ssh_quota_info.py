"""查看配额使用情况和MCC数量"""
import paramiko
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

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
    client.close()
    return out.strip()

def ssh_cmd(cmd, timeout=30):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, PORT, USER, PASS, timeout=10)
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace')
    client.close()
    return out.strip()

# 1. 所有活跃MCC
print("=== 所有活跃MCC ===")
out = ssh_sql("SELECT m.id, m.mcc_id, m.mcc_name, m.currency, m.last_sync_status, m.last_sync_date, m.last_sync_at, m.total_campaigns, m.total_customers, u.username FROM google_mcc_accounts m JOIN users u ON m.user_id = u.id WHERE m.is_active = 1 ORDER BY m.id")
print(out)

# 2. 每个MCC的广告系列数量
print("\n=== 每个MCC的广告系列数量 (最近一天) ===")
out = ssh_sql("SELECT g.mcc_id, m.mcc_name, g.date, COUNT(*) as campaigns FROM google_ads_api_data g JOIN google_mcc_accounts m ON g.mcc_id = m.id WHERE g.date = (SELECT MAX(date) FROM google_ads_api_data WHERE mcc_id = g.mcc_id) GROUP BY g.mcc_id ORDER BY campaigns DESC")
print(out)

# 3. 总广告系列数
print("\n=== 总广告系列数 (最近同步) ===")
out = ssh_sql("SELECT COUNT(DISTINCT campaign_id) as total_campaigns FROM google_ads_api_data WHERE date >= '2026-02-20'")
print(out)

# 4. Developer Token 级别
print("\n=== Developer Token 配置 ===")
out = ssh_cmd("grep -i 'developer_token\\|DEVELOPER_TOKEN\\|GOOGLE_ADS_SHARED' ~/Google-Data-Analysis/backend/.env 2>/dev/null | head -5")
print(out)

# 5. 请求延迟配置
print("\n=== 请求延迟配置 ===")
out = ssh_cmd("grep -i 'delay\\|DELAY\\|batch_size\\|BATCH_SIZE' ~/Google-Data-Analysis/backend/.env 2>/dev/null | head -5")
print(out)

# 6. 配额相关配置
print("\n=== config.py 中的配额配置 ===")
out = ssh_cmd("grep -i 'quota\\|delay\\|batch\\|rate' ~/Google-Data-Analysis/backend/app/config.py 2>/dev/null | head -10")
print(out)

# 7. 数据缺失统计
print("\n=== 数据缺失统计 (2/19-2/27) ===")
out = ssh_sql("""
SELECT m.mcc_name, m.currency, 
       COUNT(DISTINCT g.date) as has_days,
       GROUP_CONCAT(DISTINCT g.date) as dates
FROM google_mcc_accounts m 
LEFT JOIN google_ads_api_data g ON m.id = g.mcc_id AND g.date >= '2026-02-19' AND g.date <= '2026-02-27'
WHERE m.is_active = 1
GROUP BY m.id
ORDER BY has_days
""")
print(out)
