import paramiko
import time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

script = r'''
cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 << 'PYEOF'
import sqlite3
conn = sqlite3.connect('google_analysis.db')
c = conn.cursor()

# 查找 wj06 用户
c.execute("SELECT id, username, employee_id, role FROM users WHERE username LIKE '%wj06%'")
user = c.fetchall()
print("=== wj06 用户信息 ===")
for u in user:
    print(f"  id={u[0]}, username={u[1]}, employee_id={u[2]}, role={u[3]}")

if user:
    uid = user[0][0]
    
    # 查看 wj06 的 MCC 账号
    c.execute("SELECT id, mcc_id, mcc_name, is_active, currency FROM google_mcc_accounts WHERE user_id=?", (uid,))
    mccs = c.fetchall()
    print(f"\n=== wj06 的 MCC 账号 ({len(mccs)} 个) ===")
    for m in mccs:
        print(f"  db_id={m[0]}, mcc_id={m[1]}, name={m[2]}, active={m[3]}, currency={m[4]}")
    
    # 查看 wj06 的联盟账号
    c.execute("SELECT aa.id, aa.account_name, aa.account_code, aa.is_active, ap.platform_code, ap.platform_name FROM affiliate_accounts aa JOIN affiliate_platforms ap ON aa.platform_id = ap.id WHERE aa.user_id=?", (uid,))
    accounts = c.fetchall()
    print(f"\n=== wj06 的联盟账号 ({len(accounts)} 个) ===")
    for a in accounts:
        print(f"  id={a[0]}, name={a[1]}, code={a[2]}, active={a[3]}, platform={a[4]}({a[5]})")
    
    # 查看 wj06 的 Google Ads 数据中有哪些平台
    c.execute("SELECT DISTINCT extracted_platform_code, COUNT(*) as cnt FROM google_ads_api_data WHERE user_id=? GROUP BY extracted_platform_code", (uid,))
    platforms = c.fetchall()
    print(f"\n=== wj06 的 Google Ads 数据中的平台分布 ===")
    for p in platforms:
        print(f"  platform_code={p[0]}, records={p[1]}")
    
    # 查看 wj06 最近的 Google Ads 数据（按日期）
    c.execute("SELECT date, COUNT(*) as cnt, SUM(cost) as total_cost FROM google_ads_api_data WHERE user_id=? GROUP BY date ORDER BY date DESC LIMIT 10", (uid,))
    dates = c.fetchall()
    print(f"\n=== wj06 最近的 Google Ads 数据 ===")
    for d in dates:
        print(f"  date={d[0]}, records={d[1]}, cost={d[2]:.2f}")
    
    # 查看 wj06 的 RW 相关广告系列
    c.execute("SELECT campaign_id, campaign_name, extracted_platform_code, date, cost, status FROM google_ads_api_data WHERE user_id=? AND (campaign_name LIKE '%RW%' OR extracted_platform_code='RW') ORDER BY date DESC LIMIT 20", (uid,))
    rw_campaigns = c.fetchall()
    print(f"\n=== wj06 的 RW 相关广告系列 ({len(rw_campaigns)} 条) ===")
    for r in rw_campaigns:
        print(f"  campaign_id={r[0]}, name={r[1]}, platform={r[2]}, date={r[3]}, cost={r[4]:.4f}, status={r[5]}")
    
    # 查看 wj06 所有广告系列名（去重）
    c.execute("SELECT DISTINCT campaign_name, extracted_platform_code, extracted_account_code FROM google_ads_api_data WHERE user_id=?", (uid,))
    all_campaigns = c.fetchall()
    print(f"\n=== wj06 所有广告系列（去重）({len(all_campaigns)} 个) ===")
    for ac in all_campaigns:
        print(f"  name={ac[0]}, platform={ac[1]}, account_code={ac[2]}")

conn.close()
PYEOF
'''

stdin, stdout, stderr = ssh.exec_command(script, timeout=30)
print(stdout.read().decode())
err = stderr.read().decode()
if err:
    print("STDERR:", err)
ssh.close()
