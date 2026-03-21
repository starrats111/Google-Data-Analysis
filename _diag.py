"""Verify database cleanup"""
import sys, io, paramiko

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

CLEANED = [
    "affiliate_transactions", "ads_daily_stats", "articles", "campaigns",
    "ad_groups", "keywords", "ad_creatives", "user_merchants",
    "mcc_cid_accounts", "notifications", "operation_logs", "ai_insights",
    "merchant_violations", "merchant_recommendations", "merchant_policy_reviews", "site_migrations",
]
PRESERVED = [
    "users", "teams", "platform_connections", "google_mcc_accounts",
    "ad_default_settings", "notification_preferences",
    "ai_providers", "ai_model_configs", "system_configs",
    "publish_sites", "sheet_configs", "ad_policy_categories", "holiday_calendar",
]

def run():
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, PORT, USER, PASS, timeout=10)
    try:
        print("=== Cleaned Tables (should be 0) ===")
        for t in CLEANED:
            cmd = f"mysql -u crm -p'CrmPass2026!' google-data-analysis -N -e 'SELECT COUNT(1) FROM {t}' 2>/dev/null"
            _, stdout, _ = client.exec_command(cmd, timeout=10)
            cnt = stdout.read().decode("utf-8", errors="replace").strip()
            print(f"  {t}: {cnt}")

        print("\n=== Preserved Tables ===")
        for t in PRESERVED:
            cmd = f"mysql -u crm -p'CrmPass2026!' google-data-analysis -N -e 'SELECT COUNT(1) FROM {t}' 2>/dev/null"
            _, stdout, _ = client.exec_command(cmd, timeout=10)
            cnt = stdout.read().decode("utf-8", errors="replace").strip()
            print(f"  {t}: {cnt}")
    finally:
        client.close()

if __name__ == "__main__":
    run()
