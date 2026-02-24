#!/usr/bin/env python3
import sqlite3
import os

db_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'google_analysis.db')
print(f"Database path: {db_path}")
print(f"Database exists: {os.path.exists(db_path)}")

if os.path.exists(db_path):
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    tables = cursor.fetchall()
    print(f"\nTables in database:")
    for table in tables:
        print(f"  - {table[0]}")
    
    # 检查google_mcc_accounts表是否存在
    if any('google_mcc_accounts' in str(t) for t in tables):
        print("\n[OK] google_mcc_accounts table exists")
        cursor.execute("SELECT COUNT(*) FROM google_mcc_accounts")
        count = cursor.fetchone()[0]
        print(f"  Records: {count}")
    else:
        print("\n[ERROR] google_mcc_accounts table does NOT exist")
    
    conn.close()
else:
    print("\n[ERROR] Database file does not exist")


















