#!/usr/bin/env python
"""检查数据库中的所有表名"""
import sqlite3

conn = sqlite3.connect('google_analysis.db')
cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
tables = [row[0] for row in cursor.fetchall()]

print("现有数据库表：")
print("-" * 40)
for table in tables:
    print(f"  - {table}")

print(f"\n共 {len(tables)} 张表")

# 检查是否有 luchu 相关表
luchu_tables = [t for t in tables if 'luchu' in t.lower()]
if luchu_tables:
    print(f"\n⚠️ 发现已存在的 luchu 表: {luchu_tables}")
else:
    print("\n✅ 没有 luchu 相关表，可以安全创建")

conn.close()

