import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

sftp = ssh.open_sftp()
with sftp.open("/tmp/check_commission.py", "w") as f:
    f.write("""
import sys, os
sys.path.insert(0, "/home/admin/Google-Data-Analysis/backend")
os.chdir("/home/admin/Google-Data-Analysis/backend")

from app.database import SessionLocal
from sqlalchemy import text

db = SessionLocal()

# 1. Check platform values in merchants vs transactions
print("=== Merchant platforms ===")
rows = db.execute(text(
    "SELECT platform, COUNT(*) FROM affiliate_merchants GROUP BY platform ORDER BY COUNT(*) DESC"
)).fetchall()
for r in rows:
    print(f"  {r[0]}: {r[1]}")

print()
print("=== Transaction platforms ===")
rows = db.execute(text(
    "SELECT platform, COUNT(*) FROM affiliate_transactions GROUP BY platform ORDER BY COUNT(*) DESC"
)).fetchall()
for r in rows:
    print(f"  {r[0]}: {r[1]}")

# 2. Check if any transactions have commission > 0
print()
print("=== Transactions with commission ===")
rows = db.execute(text(
    "SELECT platform, COUNT(*), SUM(commission_amount) "
    "FROM affiliate_transactions "
    "WHERE commission_amount > 0 "
    "GROUP BY platform"
)).fetchall()
for r in rows:
    print(f"  {r[0]}: {r[1]} txs, total=${r[2]:.2f}")

# 3. Check a specific merchant that should have commission
print()
print("=== Sample: Mous (from screenshot) ===")
rows = db.execute(text(
    "SELECT id, merchant_id, merchant_name, platform FROM affiliate_merchants "
    "WHERE merchant_name LIKE '%Mous%' LIMIT 5"
)).fetchall()
for r in rows:
    print(f"  id={r[0]} mid={r[1]} name={r[2]} platform={r[3]}")
    if r[1]:
        txs = db.execute(text(
            "SELECT COUNT(*), SUM(commission_amount) FROM affiliate_transactions "
            "WHERE merchant_id = :mid"
        ), {"mid": r[1]}).fetchone()
        print(f"    Transactions: {txs[0]}, Total: ${txs[1] or 0:.2f}")
        # Also check with platform filter
        txs2 = db.execute(text(
            "SELECT COUNT(*), SUM(commission_amount) FROM affiliate_transactions "
            "WHERE merchant_id = :mid AND platform = :plat"
        ), {"mid": r[1], "plat": r[3]}).fetchone()
        print(f"    With platform={r[3]}: {txs2[0]}, Total: ${txs2[1] or 0:.2f}")

# 4. Check categories
print()
print("=== Category samples ===")
rows = db.execute(text(
    "SELECT DISTINCT category FROM affiliate_merchants WHERE category IS NOT NULL LIMIT 20"
)).fetchall()
for r in rows:
    print(f"  '{r[0]}'")

db.close()
""")
sftp.close()

stdin, stdout, stderr = ssh.exec_command(
    "cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 /tmp/check_commission.py 2>&1",
    timeout=30
)
print(stdout.read().decode('utf-8', errors='replace'), flush=True)

ssh.close()
