import paramiko, sys, time
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

def run(cmd, timeout=30):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace'), stderr.read().decode('utf-8', errors='replace')

PROJECT = "/home/admin/Google-Data-Analysis"

print("=== Pull ===", flush=True)
out, _ = run(f"cd {PROJECT} && git fetch origin && git reset --hard origin/main 2>&1")
print(out.strip(), flush=True)

print("\n=== Restart ===", flush=True)
run("pkill -9 -f uvicorn 2>/dev/null")
time.sleep(3)
run("fuser -k 8000/tcp 2>/dev/null")
time.sleep(2)
channel = ssh.get_transport().open_session()
channel.exec_command(f"cd {PROJECT}/backend && source venv/bin/activate && nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > /home/admin/backend.log 2>&1 &")
time.sleep(7)
out, _ = run("curl -s http://localhost:8000/health")
print(f"Health: {out}", flush=True)

# Verify commission fix
print("\n=== Verify Commission Fix ===", flush=True)
out, _ = run(f"""cd {PROJECT}/backend && source venv/bin/activate && python3 -c "
from app.database import SessionLocal
from sqlalchemy import text, func
from app.models.merchant import AffiliateMerchant
from app.models.affiliate_transaction import AffiliateTransaction

db = SessionLocal()
# Test Mous (PM, mid=59053)
txs = db.execute(text(
    \"SELECT COUNT(*), SUM(commission_amount) FROM affiliate_transactions \"
    \"WHERE LOWER(platform) = LOWER('PM') AND merchant_id = '59053'\"
)).fetchone()
print(f'Mous (PM/59053): {txs[0]} txs, total=\${{txs[1] or 0:.2f}}')

# Test a few more
txs2 = db.execute(text(
    \"SELECT COUNT(*), SUM(commission_amount) FROM affiliate_transactions \"
    \"WHERE LOWER(platform) = LOWER('CG') AND merchant_id = '18646374'\"
)).fetchone()
print(f'MajorFitness (CG/18646374): {txs2[0]} txs, total=\${{txs2[1] or 0:.2f}}')
db.close()
" 2>&1""")
print(out, flush=True)

ssh.close()
print("Done!", flush=True)
