"""计算配额消耗和缺口"""
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

# 1. 每个MCC的customer数量
print("=== 每个MCC的customer数量 ===")
out = ssh_sql("SELECT id, mcc_name, total_customers, total_campaigns, currency FROM google_mcc_accounts WHERE is_active=1 ORDER BY total_customers DESC")
print(out)

# 2. 计算每日配额消耗
print("\n=== 配额消耗估算 ===")
out = ssh_sql("SELECT SUM(total_customers) as total_customers, COUNT(*) as mcc_count FROM google_mcc_accounts WHERE is_active=1")
print(f"总customer数: {out}")

# 3. 缺失天数统计 (2026-01-31 到 2026-02-26)
print("\n=== 缺失天数统计 (需要补齐的) ===")
out = ssh_sql("""
SELECT m.mcc_name, m.total_customers,
       (SELECT COUNT(DISTINCT g.date) FROM google_ads_api_data g WHERE g.mcc_id=m.id AND g.date >= '2026-01-31' AND g.date <= '2026-02-26') as has_days,
       27 - (SELECT COUNT(DISTINCT g.date) FROM google_ads_api_data g WHERE g.mcc_id=m.id AND g.date >= '2026-01-31' AND g.date <= '2026-02-26') as missing_days
FROM google_mcc_accounts m
WHERE m.is_active=1
ORDER BY missing_days DESC
""")
print(out)

# 4. 最近7天缺失 (最紧急)
print("\n=== 最近7天缺失 (2/20-2/26, 最紧急) ===")
out = ssh_sql("""
SELECT m.mcc_name, m.total_customers,
       (SELECT COUNT(DISTINCT g.date) FROM google_ads_api_data g WHERE g.mcc_id=m.id AND g.date >= '2026-02-20' AND g.date <= '2026-02-26') as has_days,
       7 - (SELECT COUNT(DISTINCT g.date) FROM google_ads_api_data g WHERE g.mcc_id=m.id AND g.date >= '2026-02-20' AND g.date <= '2026-02-26') as missing_days
FROM google_mcc_accounts m
WHERE m.is_active=1
ORDER BY missing_days DESC
""")
print(out)
