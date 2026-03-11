import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

sftp = ssh.open_sftp()
with sftp.open("/tmp/verify_commission.py", "w") as f:
    f.write("""
import sys, os
sys.path.insert(0, "/home/admin/Google-Data-Analysis/backend")
os.chdir("/home/admin/Google-Data-Analysis/backend")

from app.database import SessionLocal
from sqlalchemy import text

db = SessionLocal()

# Test case-insensitive match
tests = [
    ("PM", "59053", "Mous"),
    ("CG", "18646374", "MajorFitness"),
    ("RW", "104850", "Mous RW"),
]

for plat, mid, name in tests:
    row = db.execute(text(
        "SELECT COUNT(*), COALESCE(SUM(commission_amount), 0) "
        "FROM affiliate_transactions "
        "WHERE LOWER(platform) = LOWER(:plat) AND merchant_id = :mid"
    ), {"plat": plat, "mid": mid}).fetchone()
    print(f"{name} ({plat}/{mid}): {row[0]} txs, ${row[1]:.2f}")

# Overall commission totals with case-insensitive
print()
print("=== Total commissions by platform (case-insensitive) ===")
rows = db.execute(text(
    "SELECT UPPER(platform), COUNT(*), COALESCE(SUM(commission_amount), 0) "
    "FROM affiliate_transactions "
    "WHERE commission_amount > 0 "
    "GROUP BY UPPER(platform) "
    "ORDER BY SUM(commission_amount) DESC"
)).fetchall()
for r in rows:
    print(f"  {r[0]}: {r[1]} txs, ${r[2]:.2f}")

db.close()
""")
sftp.close()

stdin, stdout, stderr = ssh.exec_command(
    "cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 /tmp/verify_commission.py 2>&1",
    timeout=20
)
print(stdout.read().decode('utf-8', errors='replace'), flush=True)

ssh.close()
