import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

script = r'''
cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 << 'PYEOF'
import sqlite3
conn = sqlite3.connect('google_analysis.db')
c = conn.cursor()

# 查看所有平台的 platform_code 和 platform_name
c.execute("SELECT id, platform_code, platform_name FROM affiliate_platforms ORDER BY id")
platforms = c.fetchall()
print("=== 所有联盟平台 ===")
for p in platforms:
    print(f"  id={p[0]}, platform_code={p[1]}, platform_name={p[2]}")

# 查看 wj06 (user_id=7) 的联盟账号详细信息
c.execute("""
    SELECT aa.id, aa.account_name, aa.account_code, aa.merchant_id, aa.is_active, 
           ap.id as platform_id, ap.platform_code, ap.platform_name
    FROM affiliate_accounts aa 
    JOIN affiliate_platforms ap ON aa.platform_id = ap.id 
    WHERE aa.user_id = 7
""")
accounts = c.fetchall()
print("\n=== wj06 的联盟账号详细信息 ===")
for a in accounts:
    print(f"  id={a[0]}, name={a[1]}, account_code={a[2]}, merchant_id={a[3]}, active={a[4]}, platform_id={a[5]}, platform_code={a[6]}, platform_name={a[7]}")

# 查看 wj06 的 RW 广告系列中提取的 platform_code 和 account_code
c.execute("""
    SELECT DISTINCT extracted_platform_code, extracted_account_code 
    FROM google_ads_api_data 
    WHERE user_id = 7 AND (extracted_platform_code LIKE '%rw%' OR extracted_platform_code LIKE '%RW%')
""")
rw_codes = c.fetchall()
print("\n=== wj06 RW 广告系列的 platform_code 和 account_code ===")
for r in rw_codes:
    print(f"  platform_code={r[0]}, account_code={r[1]}")

# 查看 wj06 的 RW 平台数据（PlatformData）
c.execute("""
    SELECT pd.id, pd.date, pd.commission, pd.orders, pd.merchant_name, pd.merchant_id,
           aa.account_name, ap.platform_code, ap.platform_name
    FROM platform_data pd
    JOIN affiliate_accounts aa ON pd.affiliate_account_id = aa.id
    JOIN affiliate_platforms ap ON aa.platform_id = ap.id
    WHERE aa.user_id = 7 AND ap.platform_code = 'rw'
    ORDER BY pd.date DESC
    LIMIT 20
""")
pd_data = c.fetchall()
print(f"\n=== wj06 的 RW 平台数据 ({len(pd_data)} 条) ===")
for d in pd_data:
    print(f"  id={d[0]}, date={d[1]}, commission={d[2]}, orders={d[3]}, merchant={d[4]}, mid={d[5]}, account={d[6]}, platform={d[7]}({d[8]})")

# 查看 wj06 的 L7D 分析结果
c.execute("""
    SELECT id, analysis_date, analysis_type, created_at
    FROM analysis_results
    WHERE user_id = 7
    ORDER BY created_at DESC
    LIMIT 5
""")
results = c.fetchall()
print(f"\n=== wj06 最近的分析结果 ===")
for r in results:
    print(f"  id={r[0]}, date={r[1]}, type={r[2]}, created={r[3]}")

# 查看 wj06 最近的 RW 广告中有 cost > 0 的
c.execute("""
    SELECT campaign_id, campaign_name, date, cost, status, extracted_platform_code, extracted_account_code
    FROM google_ads_api_data 
    WHERE user_id = 7 AND (extracted_platform_code LIKE '%rw%' OR extracted_platform_code LIKE '%RW%') AND cost > 0
    ORDER BY date DESC
    LIMIT 20
""")
rw_active = c.fetchall()
print(f"\n=== wj06 RW 广告中有花费的 ({len(rw_active)} 条) ===")
for r in rw_active:
    print(f"  campaign={r[0]}, name={r[1]}, date={r[2]}, cost={r[3]:.4f}, status={r[4]}, platform={r[5]}, account={r[6]}")

# 查看 wj06 的 RW 广告中 status=已启用 的
c.execute("""
    SELECT DISTINCT campaign_id, campaign_name, status, extracted_platform_code, extracted_account_code
    FROM google_ads_api_data 
    WHERE user_id = 7 AND (extracted_platform_code LIKE '%rw%' OR extracted_platform_code LIKE '%RW%') AND status LIKE '%启用%'
""")
rw_enabled = c.fetchall()
print(f"\n=== wj06 RW 已启用的广告系列 ({len(rw_enabled)} 条) ===")
for r in rw_enabled:
    print(f"  campaign={r[0]}, name={r[1]}, status={r[2]}, platform={r[3]}, account={r[4]}")

conn.close()
PYEOF
'''

stdin, stdout, stderr = ssh.exec_command(script, timeout=30)
print(stdout.read().decode())
err = stderr.read().decode()
if err:
    print("STDERR:", err)
ssh.close()
