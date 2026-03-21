"""
Data Migration Script: SQLite (old data analysis platform) -> MariaDB (new ad automation system)

Migrates critical data:
1. teams -> teams
2. users -> users  
3. pub_sites -> publish_sites
4. sheet_configs -> sheet_configs
5. google_mcc_accounts -> google_mcc_accounts
6. affiliate_accounts -> platform_connections (API tokens)
7. affiliate_merchants + merchant_assignments -> user_merchants
8. affiliate_transactions -> affiliate_transactions
9. pub_articles -> articles
10. merchant_violations -> merchant_violations
11. merchant_recommendations -> merchant_recommendations
12. notifications -> notifications
"""
import sqlite3
import json
import os
import re
import sys
from datetime import datetime

import pymysql

RESUME_FROM = int(os.environ.get("RESUME_FROM", "1"))


SQLITE_PATH = "/home/admin/Google-Data-Analysis/backend/google_analysis.db"
MARIADB_CONFIG = {
    "host": "localhost",
    "port": 3306,
    "user": "crm",
    "password": "CrmPass2026!",
    "database": "google-data-analysis",
    "charset": "utf8mb4",
}

PLATFORM_ID_TO_CODE = {1: "RW", 2: "LB", 3: "LH", 4: "CG", 5: "PM", 6: "BSH", 7: "CF"}
PLATFORM_CODE_UPPER = {"rw": "RW", "lb": "LB", "lh": "LH", "cg": "CG", "pm": "PM", "bsh": "BSH", "cf": "CF"}
ROLE_MAP = {"manager": "admin", "leader": "user", "member": "user"}


def safe_str(val, max_len=None):
    if val is None:
        return None
    s = str(val)
    if max_len:
        s = s[:max_len]
    return s


def safe_datetime(val):
    if val is None:
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
    """sqlite3.Row doesn't support .get(), so use try/except"""
    try:
        return row[key]
    except (IndexError, KeyError):
        return default


def migrate():
    print("=== Data Migration: SQLite -> MariaDB ===")
    print(f"SQLite: {SQLITE_PATH}")
    print(f"MariaDB: {MARIADB_CONFIG['database']}@{MARIADB_CONFIG['host']}")
    print()

    sqlite_conn = sqlite3.connect(SQLITE_PATH)
    sqlite_conn.row_factory = sqlite3.Row

    maria_conn = pymysql.connect(**MARIADB_CONFIG)
    maria_conn.autocommit(False)
    mc = maria_conn.cursor()

    try:
        # =============================================
        # 1. Migrate teams
        # =============================================
        print("[1/12] Migrating teams...")
        rows = sqlite_conn.execute("SELECT * FROM teams").fetchall()
        for r in rows:
            mc.execute("""
                INSERT INTO teams (id, team_code, team_name, leader_id, is_deleted, created_at, updated_at)
                VALUES (%s, %s, %s, %s, 0, %s, %s)
                ON DUPLICATE KEY UPDATE team_name=VALUES(team_name)
            """, (r["id"], safe_str(r["team_code"], 20), safe_str(r["team_name"], 50),
                  r["leader_id"], safe_datetime(r["created_at"]) or datetime.now(),
                  safe_datetime(r["updated_at"]) or datetime.now()))
        maria_conn.commit()
        print(f"  -> {len(rows)} teams migrated")

        # =============================================
        # 2. Migrate users
        # =============================================
        print("[2/12] Migrating users...")
        rows = sqlite_conn.execute("SELECT * FROM users").fetchall()
        for r in rows:
            role = ROLE_MAP.get(r["role"], "user")
            mc.execute("""
                INSERT INTO users (id, username, password_hash, plain_password, role, status, team_id,
                                   display_name, is_deleted, created_at, updated_at)
                VALUES (%s, %s, %s, NULL, %s, 'active', %s, %s, 0, %s, %s)
                ON DUPLICATE KEY UPDATE display_name=VALUES(display_name)
            """, (r["id"], safe_str(r["username"], 64), safe_str(r["password_hash"], 255),
                  role, r["team_id"], safe_str(r["display_name"], 50),
                  safe_datetime(r["created_at"]) or datetime.now(),
                  safe_datetime(r["updated_at"]) or datetime.now()))
        maria_conn.commit()
        print(f"  -> {len(rows)} users migrated")

        # =============================================
        # 3. Migrate pub_sites -> publish_sites
        # =============================================
        print("[3/12] Migrating pub_sites -> publish_sites...")
        rows = sqlite_conn.execute("SELECT * FROM pub_sites").fetchall()
        for r in rows:
            mc.execute("""
                INSERT INTO publish_sites (id, site_name, domain, site_path, site_type,
                    data_js_path, article_var_name, article_html_pattern,
                    deploy_type, status, verified, is_deleted, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'bt_ssh', 'active', 1, 0, %s, %s)
                ON DUPLICATE KEY UPDATE site_name=VALUES(site_name)
            """, (r["id"], safe_str(r["site_name"], 128), safe_str(r["domain"], 200),
                  safe_str(r["site_path"], 300), safe_str(r["site_type"], 30),
                  safe_str(r["data_js_path"], 200) or "js/articles-index.js",
                  safe_str(r["article_var_name"], 100),
                  safe_str(r["article_html_pattern"], 100),
                  safe_datetime(r["created_at"]) or datetime.now(),
                  safe_datetime(r["updated_at"]) or datetime.now()))
        maria_conn.commit()
        print(f"  -> {len(rows)} publish_sites migrated")

        # =============================================
        # 4. Migrate sheet_configs
        # =============================================
        print("[4/12] Migrating sheet_configs...")
        rows = sqlite_conn.execute("SELECT * FROM sheet_configs").fetchall()
        for r in rows:
            mc.execute("""
                INSERT INTO sheet_configs (id, config_type, sheet_url, last_synced_at,
                    updated_by, is_deleted, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, 0, %s, %s)
                ON DUPLICATE KEY UPDATE sheet_url=VALUES(sheet_url)
            """, (r["id"], safe_str(r["config_type"], 32), r["sheet_url"],
                  safe_datetime(r["last_synced_at"]), r["updated_by"],
                  safe_datetime(r["created_at"]) or datetime.now(),
                  safe_datetime(r["updated_at"]) or datetime.now()))
        maria_conn.commit()
        print(f"  -> {len(rows)} sheet_configs migrated")

        # =============================================
        # 5. Migrate google_mcc_accounts
        # =============================================
        print("[5/12] Migrating google_mcc_accounts...")
        rows = sqlite_conn.execute("SELECT * FROM google_mcc_accounts").fetchall()
        for r in rows:
            mc.execute("""
                INSERT INTO google_mcc_accounts (id, user_id, mcc_id, mcc_name, currency,
                    service_account_json, sheet_url, developer_token, is_active, is_deleted,
                    created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, NULL, %s, 0, %s, %s)
                ON DUPLICATE KEY UPDATE mcc_name=VALUES(mcc_name)
            """, (r["id"], r["user_id"], safe_str(r["mcc_id"], 32),
                  safe_str(r["mcc_name"], 128), safe_str(r["currency"], 8) or "USD",
                  r["service_account_json"], safe_str(r["google_sheet_url"], 1024),
                  1 if r["is_active"] else 0,
                  safe_datetime(r["created_at"]) or datetime.now(),
                  safe_datetime(r["updated_at"]) or datetime.now()))
        maria_conn.commit()
        print(f"  -> {len(rows)} google_mcc_accounts migrated")

        # =============================================
        # 6. Migrate affiliate_accounts -> platform_connections
        # =============================================
        print("[6/12] Migrating affiliate_accounts -> platform_connections...")
        rows = sqlite_conn.execute("SELECT * FROM affiliate_accounts").fetchall()
        for r in rows:
            platform_code = PLATFORM_ID_TO_CODE.get(r["platform_id"], "")
            api_key = None
            if r["notes"]:
                try:
                    notes_data = json.loads(r["notes"])
                    api_key = notes_data.get("api_token") or notes_data.get("collabglow_token") or notes_data.get("linkhaitao_token")
                except (json.JSONDecodeError, TypeError):
                    api_key = None
            if not api_key and r["api_token_encrypted"]:
                api_key = r["api_token_encrypted"]

            mc.execute("""
                INSERT INTO platform_connections (id, user_id, platform, account_name, api_key,
                    publish_site_id, status, last_synced_at, is_deleted, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, NULL, 'connected', NULL, 0, %s, %s)
                ON DUPLICATE KEY UPDATE api_key=VALUES(api_key)
            """, (r["id"], r["user_id"], platform_code,
                  safe_str(r["account_name"], 32) or "",
                  api_key,
                  safe_datetime(r["created_at"]) or datetime.now(),
                  safe_datetime(r["updated_at"]) or datetime.now()))
        maria_conn.commit()
        print(f"  -> {len(rows)} platform_connections migrated")

        # =============================================
        # 7. Migrate affiliate_merchants + merchant_assignments -> user_merchants
        # =============================================
        print("[7/12] Migrating merchants -> user_merchants...")
        assignments = sqlite_conn.execute("""
            SELECT ma.*, am.merchant_id as mid, am.merchant_name, am.platform,
                   am.category, am.commission_rate, am.logo_url, am.violation_status,
                   am.violation_time, am.recommendation_status, am.recommendation_time
            FROM merchant_assignments ma
            JOIN affiliate_merchants am ON ma.merchant_id = am.id
        """).fetchall()

        count = 0
        for r in assignments:
            platform = PLATFORM_CODE_UPPER.get(r["platform"], safe_str(r["platform"], 8) or "")
            mc.execute("""
                INSERT INTO user_merchants (user_id, platform, merchant_id, merchant_name,
                    merchant_url, category, commission_rate, status, claimed_at,
                    target_country, tracking_link, violation_status, violation_time,
                    recommendation_status, recommendation_time, policy_status,
                    is_deleted, created_at, updated_at)
                VALUES (%s, %s, %s, %s, NULL, %s, %s, %s, %s, %s, NULL, %s, %s, %s, %s, 'pending', 0, %s, %s)
            """, (r["user_id"], platform, safe_str(r["mid"], 64) or "",
                  safe_str(r["merchant_name"], 255) or "",
                  safe_str(r["category"], 128), safe_str(r["commission_rate"], 64),
                  "claimed" if r["status"] in ("active", "completed") else "available",
                  safe_datetime(r["assigned_at"]),
                  safe_str(r["target_country"], 8),
                  safe_str(r["violation_status"], 20) or "normal",
                  safe_datetime(r["violation_time"]),
                  safe_str(r["recommendation_status"], 20) or "normal",
                  safe_datetime(r["recommendation_time"]),
                  safe_datetime(r["created_at"]) or datetime.now(),
                  safe_datetime(r["updated_at"]) or datetime.now()))
            count += 1
        maria_conn.commit()
        print(f"  -> {count} user_merchants migrated from assignments")

        # =============================================
        # 8. Migrate affiliate_transactions
        # =============================================
        print("[8/12] Migrating affiliate_transactions (56K rows, batch mode)...")
        rows = sqlite_conn.execute("SELECT * FROM affiliate_transactions").fetchall()
        batch = []
        for r in rows:
            platform = PLATFORM_CODE_UPPER.get(r["platform"], safe_str(r["platform"], 8) or "")
            batch.append((
                r["user_id"] or 0, 0, None,
                platform, safe_str(r["merchant_id"], 64) or "",
                safe_str(r["merchant"], 255) or "",
                safe_str(r["transaction_id"], 128),
                safe_datetime(r["transaction_time"]) or datetime.now(),
                float(r["order_amount"] or 0), float(r["commission_amount"] or 0),
                safe_str(r["currency"], 8) or "USD",
                safe_str(r["status"], 16) or "pending",
                safe_str(r["raw_status"], 32),
                safe_datetime(r["created_at"]) or datetime.now(),
                safe_datetime(r["updated_at"]) or datetime.now(),
            ))

        for i in range(0, len(batch), 1000):
            chunk = batch[i:i+1000]
            mc.executemany("""
                INSERT INTO affiliate_transactions (user_id, user_merchant_id, campaign_id,
                    platform, merchant_id, merchant_name,
                    transaction_id, transaction_time, order_amount, commission_amount,
                    currency, status, raw_status, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, chunk)
            maria_conn.commit()
            print(f"  -> batch {i//1000+1}: {len(chunk)} rows")
        print(f"  -> {len(batch)} affiliate_transactions migrated total")

        # =============================================
        # 9. Migrate pub_articles -> articles
        # =============================================
        print("[9/12] Migrating pub_articles -> articles...")
        rows = sqlite_conn.execute("SELECT * FROM pub_articles WHERE deleted_at IS NULL").fetchall()
        status_map = {"published": "published", "draft": "preview", "generating": "generating"}
        for r in rows:
            kw_json = None
            if r["meta_keywords"]:
                kw_json = json.dumps([k.strip() for k in r["meta_keywords"].split(",") if k.strip()])

            images_json = None
            if r["featured_image"]:
                images_json = json.dumps([r["featured_image"]])

            mc.execute("""
                INSERT INTO articles (user_id, user_merchant_id, publish_site_id, title, slug,
                    content, excerpt, language, keywords, images, status, published_at,
                    published_url, merchant_name, tracking_link, meta_title, meta_description,
                    is_deleted, created_at, updated_at)
                VALUES (%s, NULL, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NULL, %s, %s, %s, %s, 0, %s, %s)
            """, (r["user_id"], r["site_id"],
                  safe_str(r["title"], 512), safe_str(r["slug"], 512),
                  r["content"], r["excerpt"],
                  safe_str(r["language"], 8) or "en",
                  kw_json, images_json,
                  status_map.get(r["status"], "preview"),
                  safe_datetime(r["publish_date"]),
                  safe_str(r["merchant_name"], 255),
                  r["tracking_link"],
                  safe_str(r["meta_title"], 512), r["meta_description"],
                  safe_datetime(r["created_at"]) or datetime.now(),
                  safe_datetime(r["updated_at"]) or datetime.now()))
        maria_conn.commit()
        print(f"  -> {len(rows)} articles migrated")

        # =============================================
        # 10. Migrate merchant_violations
        # =============================================
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

        # =============================================
        # 11. Migrate merchant_recommendations
        # =============================================
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

        # =============================================
        # 12. Migrate notifications
        # =============================================
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

        print()
        print("=== Migration Complete ===")

        # Verify counts
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
            print(f"  {t}: {count}")

    except Exception as e:
        maria_conn.rollback()
        print(f"\n!!! ERROR: {e}")
        import traceback
        traceback.print_exc()
        raise
    finally:
        sqlite_conn.close()
        maria_conn.close()


if __name__ == "__main__":
    migrate()
