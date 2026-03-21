"""Diagnostic: check MCC token + transactions linking"""
import sys, paramiko

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

QUERIES = [
    ("Users 30+",
     "SELECT id, username, display_name FROM users WHERE id > 30 LIMIT 20"),
    ("Campaigns MCC distribution",
     "SELECT c.mcc_id, m.mcc_id as mcc_code, m.mcc_name, m.developer_token IS NOT NULL as has_token, COUNT(1) as cnt FROM campaigns c JOIN google_mcc_accounts m ON c.mcc_id = m.id WHERE c.is_deleted=0 GROUP BY c.mcc_id, m.mcc_id, m.mcc_name, has_token ORDER BY cnt DESC"),
    ("All MCC per user 2 and 8",
     "SELECT user_id, id, mcc_id, mcc_name, developer_token IS NOT NULL as has_token FROM google_mcc_accounts WHERE is_deleted=0 AND user_id IN (2, 8) ORDER BY user_id, id"),
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
