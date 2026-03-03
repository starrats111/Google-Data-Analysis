"""检查 wj04/wj05 的数据存储情况"""
import sqlite3
conn = sqlite3.connect('google_analysis.db')
c = conn.cursor()

# 1. 用户
print("=== 用户 ===")
c.execute("SELECT id, username FROM users WHERE username IN ('wj04','wj05')")
users = c.fetchall()
for u in users:
    print(f"  ID={u[0]}, username={u[1]}")

# 2. MCC 绑定
print("\n=== MCC 绑定 ===")
for u in users:
    c.execute("SELECT id, mcc_id, mcc_name, is_active FROM google_mcc_accounts WHERE user_id=?", (u[0],))
    mccs = c.fetchall()
    if mccs:
        for m in mccs:
            print(f"  {u[1]}: MCC db_id={m[0]}, mcc_id={m[1]}, name={m[2]}, active={m[3]}")
    else:
        print(f"  {u[1]}: 没有绑定MCC!")

# 3. 检查 google_ads_api_data 中的数据
print("\n=== google_ads_api_data 数据量 ===")
for u in users:
    c.execute("SELECT COUNT(*) FROM google_ads_api_data WHERE user_id=?", (u[0],))
    cnt = c.fetchone()[0]
    print(f"  {u[1]} (ID={u[0]}): {cnt} 条记录")
    if cnt > 0:
        c.execute("SELECT MIN(date), MAX(date) FROM google_ads_api_data WHERE user_id=?", (u[0],))
        r = c.fetchone()
        print(f"    日期范围: {r[0]} ~ {r[1]}")
        c.execute("SELECT DISTINCT status FROM google_ads_api_data WHERE user_id=?", (u[0],))
        statuses = [s[0] for s in c.fetchall()]
        print(f"    状态: {statuses}")

# 4. 检查是否数据存在 mcc_id 而非 user_id
print("\n=== 按 mcc_id 查找数据 ===")
# 先找到 wj04/wj05 的 MCC ID
for u in users:
    c.execute("SELECT mcc_id FROM google_mcc_accounts WHERE user_id=?", (u[0],))
    mccs = c.fetchall()
    for m in mccs:
        mcc_id = m[0]
        c.execute("SELECT COUNT(*) FROM google_ads_api_data WHERE mcc_id=?", (mcc_id,))
        cnt = c.fetchone()[0]
        print(f"  {u[1]} MCC {mcc_id}: {cnt} 条记录")
        if cnt > 0:
            c.execute("SELECT MIN(date), MAX(date) FROM google_ads_api_data WHERE mcc_id=?", (mcc_id,))
            r = c.fetchone()
            print(f"    日期范围: {r[0]} ~ {r[1]}")
            c.execute("SELECT DISTINCT user_id FROM google_ads_api_data WHERE mcc_id=?", (mcc_id,))
            uids = [s[0] for s in c.fetchall()]
            print(f"    关联的 user_id: {uids}")

# 5. 检查 google_ads_api_data 表结构
print("\n=== google_ads_api_data 表结构 ===")
c.execute("PRAGMA table_info(google_ads_api_data)")
for col in c.fetchall():
    print(f"  {col[1]} ({col[2]})")

# 6. 看看所有 user_id 的数据分布
print("\n=== 所有 user_id 的数据分布 ===")
c.execute("SELECT user_id, COUNT(*), MIN(date), MAX(date) FROM google_ads_api_data GROUP BY user_id")
for r in c.fetchall():
    c.execute("SELECT username FROM users WHERE id=?", (r[0],))
    uname = c.fetchone()
    uname = uname[0] if uname else "UNKNOWN"
    print(f"  user_id={r[0]} ({uname}): {r[1]} 条, {r[2]} ~ {r[3]}")

conn.close()
