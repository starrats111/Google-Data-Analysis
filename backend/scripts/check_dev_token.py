#!/usr/bin/env python3
"""
检查Developer Token配置
"""
import sys
import os
from pathlib import Path

# 添加项目根目录到路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import settings

print("=" * 80)
print("Developer Token配置检查")
print("=" * 80)

# 检查配置值
token = settings.google_ads_shared_developer_token

print(f"\n配置项名称: google_ads_shared_developer_token")
print(f"配置值类型: {type(token)}")
print(f"配置值: {repr(token)}")
print(f"是否为空字符串: {token == ''}")
print(f"是否为None: {token is None}")
print(f"长度: {len(token) if token else 0}")
print(f"去除空格后长度: {len(token.strip()) if token else 0}")

# 检查是否配置
has_token = bool(token and token.strip())
print(f"\n检测结果: {'[已配置]' if has_token else '[未配置]'}")

if has_token:
    print(f"Token预览: {token[:20]}... (总长度: {len(token)})")
else:
    print("\n可能的原因:")
    print("1. .env文件中没有配置GOOGLE_ADS_SHARED_DEVELOPER_TOKEN")
    print("2. .env文件中配置了但值为空")
    print("3. 配置项名称不正确")
    print("4. .env文件位置不正确")
    
    # 检查.env文件
    env_file = Path(__file__).parent.parent / ".env"
    print(f"\n.env文件路径: {env_file}")
    print(f".env文件存在: {env_file.exists()}")
    
    if env_file.exists():
        print("\n.env文件内容:")
        try:
            with open(env_file, 'r', encoding='utf-8') as f:
                lines = f.readlines()
                for i, line in enumerate(lines, 1):
                    if 'TOKEN' in line.upper() or 'GOOGLE' in line.upper():
                        print(f"  第{i}行: {line.rstrip()}")
        except Exception as e:
            print(f"  读取文件出错: {e}")
    else:
        print("\n.env文件不存在，需要创建")

print("\n" + "=" * 80)
print("环境变量检查")
print("=" * 80)

# 检查环境变量
import os
env_token = os.environ.get('GOOGLE_ADS_SHARED_DEVELOPER_TOKEN')
print(f"环境变量GOOGLE_ADS_SHARED_DEVELOPER_TOKEN: {env_token if env_token else '(未设置)'}")

# 检查所有GOOGLE相关的环境变量
print("\n所有GOOGLE相关的环境变量:")
for key, value in os.environ.items():
    if 'GOOGLE' in key.upper() or 'TOKEN' in key.upper():
        print(f"  {key} = {value[:20]}..." if value and len(value) > 20 else f"  {key} = {value}")















