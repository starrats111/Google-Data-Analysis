#!/usr/bin/env python3
"""
07的开发者令牌更新脚本 - 超级简单版本
自动更新令牌并重启服务
"""
import os
import sys
from pathlib import Path

# 新令牌（07提供的正式访问权限令牌）
NEW_TOKEN = "hWBTxgYlOiWB4XfXQl_UfA"

def main():
    print("=== 07的开发者令牌更新 ===")
    print("")
    
    # 1. 找到.env文件
    backend_dir = Path(__file__).parent.parent
    env_file = backend_dir / ".env"
    
    print(f"步骤1: 更新 .env 文件...")
    
    # 读取现有内容
    if env_file.exists():
        with open(env_file, 'r', encoding='utf-8') as f:
            lines = f.readlines()
    else:
        lines = []
    
    # 更新或添加令牌
    updated = False
    new_lines = []
    for line in lines:
        if line.strip().startswith('GOOGLE_ADS_SHARED_DEVELOPER_TOKEN'):
            new_lines.append(f"GOOGLE_ADS_SHARED_DEVELOPER_TOKEN={NEW_TOKEN}\n")
            updated = True
        else:
            new_lines.append(line)
    
    if not updated:
        if new_lines and not new_lines[-1].endswith('\n'):
            new_lines.append('\n')
        new_lines.append(f"GOOGLE_ADS_SHARED_DEVELOPER_TOKEN={NEW_TOKEN}\n")
    
    # 写入文件
    with open(env_file, 'w', encoding='utf-8') as f:
        f.writelines(new_lines)
    
    print(f"✓ 令牌已更新到: {env_file}")
    
    # 2. 验证配置
    print("步骤2: 验证配置...")
    sys.path.insert(0, str(backend_dir))
    try:
        from app.config import settings
        token = settings.google_ads_shared_developer_token
        if token == NEW_TOKEN:
            print(f"✓ 配置验证成功！令牌长度: {len(token)} 字符")
            print(f"✓ 令牌预览: {token[:10]}...")
        else:
            print(f"✗ 配置验证失败，令牌不匹配")
            return False
    except Exception as e:
        print(f"✗ 配置验证失败: {e}")
        return False
    
    print("")
    print("=== 完成！===")
    print("")
    print("下一步: 重启服务")
    print("运行命令: cd ~/Google-Data-Analysis/backend && source venv/bin/activate && pkill -9 -f 'uvicorn.*app.main' && sleep 2 && nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &")
    print("")
    
    return True

if __name__ == "__main__":
    if main():
        print("✓ 所有步骤完成")
        sys.exit(0)
    else:
        print("✗ 更新失败")
        sys.exit(1)


"""
07的开发者令牌更新脚本 - 超级简单版本
自动更新令牌并重启服务
"""
import os
import sys
from pathlib import Path

# 新令牌（07提供的正式访问权限令牌）
NEW_TOKEN = "hWBTxgYlOiWB4XfXQl_UfA"

def main():
    print("=== 07的开发者令牌更新 ===")
    print("")
    
    # 1. 找到.env文件
    backend_dir = Path(__file__).parent.parent
    env_file = backend_dir / ".env"
    
    print(f"步骤1: 更新 .env 文件...")
    
    # 读取现有内容
    if env_file.exists():
        with open(env_file, 'r', encoding='utf-8') as f:
            lines = f.readlines()
    else:
        lines = []
    
    # 更新或添加令牌
    updated = False
    new_lines = []
    for line in lines:
        if line.strip().startswith('GOOGLE_ADS_SHARED_DEVELOPER_TOKEN'):
            new_lines.append(f"GOOGLE_ADS_SHARED_DEVELOPER_TOKEN={NEW_TOKEN}\n")
            updated = True
        else:
            new_lines.append(line)
    
    if not updated:
        if new_lines and not new_lines[-1].endswith('\n'):
            new_lines.append('\n')
        new_lines.append(f"GOOGLE_ADS_SHARED_DEVELOPER_TOKEN={NEW_TOKEN}\n")
    
    # 写入文件
    with open(env_file, 'w', encoding='utf-8') as f:
        f.writelines(new_lines)
    
    print(f"✓ 令牌已更新到: {env_file}")
    
    # 2. 验证配置
    print("步骤2: 验证配置...")
    sys.path.insert(0, str(backend_dir))
    try:
        from app.config import settings
        token = settings.google_ads_shared_developer_token
        if token == NEW_TOKEN:
            print(f"✓ 配置验证成功！令牌长度: {len(token)} 字符")
            print(f"✓ 令牌预览: {token[:10]}...")
        else:
            print(f"✗ 配置验证失败，令牌不匹配")
            return False
    except Exception as e:
        print(f"✗ 配置验证失败: {e}")
        return False
    
    print("")
    print("=== 完成！===")
    print("")
    print("下一步: 重启服务")
    print("运行命令: cd ~/Google-Data-Analysis/backend && source venv/bin/activate && pkill -9 -f 'uvicorn.*app.main' && sleep 2 && nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &")
    print("")
    
    return True

if __name__ == "__main__":
    if main():
        print("✓ 所有步骤完成")
        sys.exit(0)
    else:
        print("✗ 更新失败")
        sys.exit(1)









