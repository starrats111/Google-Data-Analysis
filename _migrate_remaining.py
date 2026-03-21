"""Run remaining migration steps 10-12 on the server"""
import sqlite3
import json
import os
import sys
from datetime import datetime

import pymysql


SQLITE_PATH = "/home/admin/Google-Data-Analysis/backend/google_analysis.db"
MARIADB_CONFIG = {
    "host": "localhost",
    "port": 3306,
    "user": "crm",
    "password": "CrmPass2026!",
    "database": "google-data-analysis",
    "charset": "utf8mb4",
}


def safe_str(val, max_len):
    if val is None:
        return None
    s = str(val)[:max_len]
    return s


def safe_datetime(val):
    if val is None:
        return None
    if isinstance(val, datetime):
        return val
    if isinstance(val, (int, float)):
        try:
            return datetime.fromtimestamp(val)
        except (ValueError, OSError):
            return None
    if isinstance(val, str):
        for fmt in ["%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"]:
            try:
                return datetime.strptime(val, fmt)
            except ValueError:
                continue
        return None
    return val


def safe_get(row, key, default=None):
    try:
        return row[key]
    except (IndexError, KeyError):
        return default


def run():
    sqlite_conn = sqlite3.connect(SQLITE_PATH)
    sqlite_conn.row_factory = sqlite3.Row
    maria_conn = pymysql.connect(**MARIADB_CONFIG)
    maria_conn.autocommit(False)
    mc = maria_conn.cursor()

    try:
        print("[10/12] Migrating merchant_violations...")
        rows = sqlite_conn.execute("SELECT * FROM merchant_violations").fetchall()
        for i in range(0, len(rows), 500):
            chunk = rows[i:i+500]
            for r in chunk:
                mc.execute("""
                    INSERT INTO merchant_violations (merchant_name, platform, merchant_domain,
                        violation_reason, violation_time, source, upload_batch, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """, (safe_str(r["merchant_name"], 255) or "",
                      safe_str(r["platform"], 32) or "",
                      safe_str(safe_get(r, "merchant_url"), 255),
                      safe_get(r, "violation_reason"),
                      safe_datetime(safe_get(r, "violation_time")),
                      None,
                      safe_str(r["upload_batch"], 64) or "",
                      safe_datetime(r["created_at"]) or datetime.now()))
            maria_conn.commit()
        print(f"  -> {len(rows)} merchant_violations migrated")

        print("[11/12] Migrating merchant_recommendations...")
        rows = sqlite_conn.execute("SELECT * FROM merchant_recommendations").fetchall()
        for r in rows:
            mc.execute("""
                INSERT INTO merchant_recommendations (merchant_name, roi_reference,
                    commission_info, settlement_info, remark, share_time,
                    upload_batch, is_deleted, created_at)
                VALUES (%s, NULL, %s, NULL, %s, NULL, %s, 0, %s)
            """, (safe_str(r["merchant_name"], 255) or "",
                  safe_str(safe_get(r, "commission_cap"), 64),
                  safe_get(r, "recommend_reason"),
                  safe_str(r["upload_batch"], 64) or "",
                  safe_datetime(r["created_at"]) or datetime.now()))
        maria_conn.commit()
        print(f"  -> {len(rows)} merchant_recommendations migrated")

        print("[12/12] Migrating notifications...")
        rows = sqlite_conn.execute("SELECT * FROM notifications").fetchall()
        for r in rows:
            mc.execute("""
                INSERT INTO notifications (user_id, type, title, content, is_read,
                    is_deleted, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, 0, %s, %s)
            """, (r["user_id"], safe_str(r["type"], 32) or "system",
                  safe_str(r["title"], 255) or "", r["content"],
                  1 if r["is_read"] else 0,
                  safe_datetime(r["created_at"]) or datetime.now(),
                  safe_datetime(r["created_at"]) or datetime.now()))
        maria_conn.commit()
        print(f"  -> {len(rows)} notifications migrated")

        print("\nVerification:")
        verify_tables = [
            "teams", "users", "publish_sites", "sheet_configs",
            "google_mcc_accounts", "platform_connections", "user_merchants",
            "affiliate_transactions", "articles", "merchant_violations",
            "merchant_recommendations", "notifications"
        ]
        for t in verify_tables:
            mc.execute(f"SELECT COUNT(*) FROM `{t}`")
            count = mc.fetchone()[0]
            print(f"  {t}: {count} rows")

        print("\n=== All steps complete! ===")

    except Exception as e:
        maria_conn.rollback()
        print(f"\n!!! ERROR: {e}")
        import traceback
        traceback.print_exc()
    finally:
        mc.close()
        maria_conn.close()
        sqlite_conn.close()

if __name__ == "__main__":
    run()
