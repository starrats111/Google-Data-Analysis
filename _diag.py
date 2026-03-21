"""Diagnostic: check MCC token + transactions linking"""
import sys, paramiko

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

QUERIES = [
    ("Txn platforms vs merchant platforms for user 2",
     "SELECT DISTINCT t.platform as txn_platform, t.merchant_id as txn_mid, m.platform as merch_platform, m.merchant_id as merch_mid FROM (SELECT DISTINCT platform, merchant_id FROM affiliate_transactions WHERE user_id=2 AND is_deleted=0 LIMIT 10) t LEFT JOIN user_merchants m ON m.user_id=2 AND m.merchant_id=t.merchant_id AND m.is_deleted=0 LIMIT 15"),
    ("User 2 merchant count",
     "SELECT COUNT(1) as cnt FROM user_merchants WHERE user_id=2 AND is_deleted=0"),
    ("User 2 sample merchants",
     "SELECT id, merchant_id, platform FROM user_merchants WHERE user_id=2 AND is_deleted=0 LIMIT 10"),
    ("User 2 sample txn merchant_ids",
     "SELECT DISTINCT merchant_id, platform FROM affiliate_transactions WHERE user_id=2 AND is_deleted=0 LIMIT 10"),
]

def run():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, PORT, USER, PASS, timeout=10)
    try:
        for title, sql in QUERIES:
            cmd = f"mysql -u crm -p'CrmPass2026!' google-data-analysis -e \"{sql}\""
            stdin, stdout, stderr = client.exec_command(cmd, timeout=30)
            out = stdout.read().decode("utf-8", errors="replace")
            err = stderr.read().decode("utf-8", errors="replace")
            print(f"\n=== {title} ===")
            print(out.strip() if out.strip() else "(no output)")
            if err.strip():
                print(f"[ERR] {err.strip()}")
    finally:
        client.close()

if __name__ == "__main__":
    run()
