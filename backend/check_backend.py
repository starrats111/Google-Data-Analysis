#!/usr/bin/env python3
"""
后端诊断脚本
检查后端启动失败的原因
"""
import sys
import os

print("=" * 50)
print("后端诊断脚本")
print("=" * 50)

# 1. 检查Python版本
print("\n1. 检查Python版本...")
print(f"Python版本: {sys.version}")

# 2. 检查必要的包
print("\n2. 检查必要的包...")
required_packages = [
    'fastapi',
    'uvicorn',
    'sqlalchemy',
    'pydantic',
    'pandas',
    'openpyxl',
    'python-multipart',
    'python-jose',
    'passlib',
    'bcrypt',
]

missing_packages = []
for package in required_packages:
    try:
        __import__(package.replace('-', '_'))
        print(f"  ✓ {package}")
    except ImportError:
        print(f"  ✗ {package} (缺失)")
        missing_packages.append(package)

if missing_packages:
    print(f"\n缺失的包: {', '.join(missing_packages)}")
    print("请运行: pip install " + " ".join(missing_packages))

# 3. 检查配置文件
print("\n3. 检查配置文件...")
try:
    from app.config import settings
    print("  ✓ 配置文件加载成功")
    print(f"  数据库URL: {settings.DATABASE_URL}")
    print(f"  CORS配置: {settings.CORS_ORIGINS[:3]}...")  # 只显示前3个
except Exception as e:
    print(f"  ✗ 配置文件加载失败: {e}")

# 4. 检查数据库
print("\n4. 检查数据库...")
try:
    from app.database import engine, Base
    from app.models import AffiliatePlatform, AffiliateAccount
    print("  ✓ 数据库连接成功")
except Exception as e:
    print(f"  ✗ 数据库连接失败: {e}")

# 5. 检查API路由
print("\n5. 检查API路由...")
try:
    from app.api import (
        auth,
        upload,
        analysis,
        dashboard,
        expenses,
        export,
        ad_campaign,
        affiliate,
        collabglow,
        stage_label,
    )
    print("  ✓ 所有API路由导入成功")
except Exception as e:
    print(f"  ✗ API路由导入失败: {e}")

# 6. 尝试创建FastAPI应用
print("\n6. 尝试创建FastAPI应用...")
try:
    from app.main import app
    print("  ✓ FastAPI应用创建成功")
    print(f"  路由数量: {len(app.routes)}")
except Exception as e:
    print(f"  ✗ FastAPI应用创建失败: {e}")
    import traceback
    traceback.print_exc()

# 7. 检查日志文件
print("\n7. 检查日志文件...")
log_file = "backend.log"
if os.path.exists(log_file):
    print(f"  ✓ 日志文件存在: {log_file}")
    print("\n  最近10行日志:")
    with open(log_file, 'r', encoding='utf-8', errors='ignore') as f:
        lines = f.readlines()
        for line in lines[-10:]:
            print(f"    {line.rstrip()}")
else:
    print(f"  ✗ 日志文件不存在: {log_file}")

print("\n" + "=" * 50)
print("诊断完成")
print("=" * 50)

