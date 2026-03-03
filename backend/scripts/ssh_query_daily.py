"""SSH查询服务器数据库 - wj04/wj05 每日明细对比"""
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
        print(f"  SQL ERROR: {err.strip()}")
    return out.strip()

# 1. 用户和MCC信息
print("=" * 100)
print("1. 用户和MCC信息")
print("=" * 100)
out = ssh_sql("SELECT u.id, u.username, m.id as mcc_db_id, m.mcc_id, m.mcc_name, m.currency, m.is_active FROM users u LEFT JOIN google_mcc_accounts m ON u.id = m.user_id WHERE u.username IN ('wj04','wj05') ORDER BY u.username")
print(out)

# 2. wj04 每日明细 (2/21-2/27)
print("\n" + "=" * 100)
print("2. wj04 每日明细 (2026-02-21 ~ 2026-02-27)")
print("=" * 100)
out = ssh_sql("""
SELECT g.campaign_name, g.date, g.impressions, g.clicks, g.cost, g.budget, 
       g.is_budget_lost, g.is_rank_lost, g.search_impression_share, g.status,
       m.currency
FROM google_ads_api_data g
JOIN users u ON g.user_id = u.id
LEFT JOIN google_mcc_accounts m ON g.mcc_id = m.id
WHERE u.username = 'wj04'
  AND g.date >= '2026-02-21' AND g.date <= '2026-02-27'
  AND g.status = '已启用'
ORDER BY g.campaign_name, g.date
""")
print(out)

# 3. wj05 每日明细 (2/21-2/27)
print("\n" + "=" * 100)
print("3. wj05 每日明细 (2026-02-21 ~ 2026-02-27)")
print("=" * 100)
out = ssh_sql("""
SELECT g.campaign_name, g.date, g.impressions, g.clicks, g.cost, g.budget, 
       g.is_budget_lost, g.is_rank_lost, g.search_impression_share, g.status,
       m.currency
FROM google_ads_api_data g
JOIN users u ON g.user_id = u.id
LEFT JOIN google_mcc_accounts m ON g.mcc_id = m.id
WHERE u.username = 'wj05'
  AND g.date >= '2026-02-21' AND g.date <= '2026-02-27'
  AND g.status = '已启用'
ORDER BY g.campaign_name, g.date
""")
print(out)
