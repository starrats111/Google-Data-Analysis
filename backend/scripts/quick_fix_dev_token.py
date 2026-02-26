#!/usr/bin/env python3
"""
快速修复Developer Token配置
如果Token值作为命令行参数提供，直接更新.env文件
"""
import sys
import os
from pathlib import Path

def quick_fix(token_value):
    """快速修复Token配置"""
    if not token_value:
        print("[错误] Token值不能为空")
        return False
    
    # 去除可能的引号和空格
    token_value = token_value.strip('"').strip("'").strip()
    
    if not token_value:
        print("[错误] Token值无效")
        return False
    
    env_file = Path(__file__).parent.parent / ".env"
    
    print(f"正在更新 .env 文件: {env_file}")
    
    # 读取现有内容
    if env_file.exists():
        with open(env_file, 'r', encoding='utf-8') as f:
            lines = f.readlines()
    else:
        lines = []
    
    # 查找并更新配置
    updated = False
    new_lines = []
    
    for line in lines:
        if line.strip().startswith('GOOGLE_ADS_SHARED_DEVELOPER_TOKEN'):
            # 更新这一行
            new_lines.append(f"GOOGLE_ADS_SHARED_DEVELOPER_TOKEN={token_value}\n")
            updated = True
        else:
            new_lines.append(line)
    
    if not updated:
        # 如果没有找到，添加到文件末尾
        if new_lines and not new_lines[-1].endswith('\n'):
            new_lines.append('\n')
        new_lines.append(f"GOOGLE_ADS_SHARED_DEVELOPER_TOKEN={token_value}\n")
    
    # 写入文件
    with open(env_file, 'w', encoding='utf-8') as f:
        f.writelines(new_lines)
    
    print(f"[成功] 已更新 .env 文件")
    print(f"[提示] 请重启后端服务以使配置生效")
    
    return True

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python quick_fix_dev_token.py <token_value>")
        print("示例: python quick_fix_dev_token.py abc123xyz789")
        sys.exit(1)
    
    token = sys.argv[1]
    if quick_fix(token):
        print("\n[完成] 配置已更新")
        print("[下一步] 请重启后端服务")
    else:
        sys.exit(1)



















