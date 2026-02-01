# -*- coding: utf-8 -*-
"""
快速查看日志的脚本
"""
import sys
import os
from pathlib import Path

if sys.platform == 'win32':
    import codecs
    sys.stdout = codecs.getwriter('utf-8')(sys.stdout.buffer, 'strict')
    sys.stderr = codecs.getwriter('utf-8')(sys.stderr.buffer, 'strict')

def view_logs(log_type='all', lines=50):
    """
    查看日志
    
    参数:
        log_type: 'all' 查看所有日志, 'error' 仅查看错误日志
        lines: 显示的行数
    """
    log_dir = Path("logs")
    
    if not log_dir.exists():
        print("日志目录不存在，请先运行服务器生成日志")
        return
    
    if log_type == 'error':
        log_file = log_dir / "error.log"
        print(f"\n{'='*60}")
        print(f"错误日志 (最后 {lines} 行)")
        print(f"{'='*60}\n")
    else:
        log_file = log_dir / "app.log"
        print(f"\n{'='*60}")
        print(f"所有日志 (最后 {lines} 行)")
        print(f"{'='*60}\n")
    
    if not log_file.exists():
        print(f"日志文件不存在: {log_file}")
        return
    
    try:
        with open(log_file, 'r', encoding='utf-8') as f:
            all_lines = f.readlines()
            if len(all_lines) == 0:
                print("日志文件为空")
                return
            
            # 显示最后N行
            start = max(0, len(all_lines) - lines)
            for line in all_lines[start:]:
                print(line.rstrip())
            
            print(f"\n{'='*60}")
            print(f"总共 {len(all_lines)} 行，显示最后 {min(lines, len(all_lines))} 行")
            print(f"{'='*60}\n")
            
    except Exception as e:
        print(f"读取日志文件失败: {e}")

def search_logs(keyword):
    """搜索日志中的关键词"""
    log_file = Path("logs/app.log")
    
    if not log_file.exists():
        print(f"日志文件不存在: {log_file}")
        return
    
    try:
        with open(log_file, 'r', encoding='utf-8') as f:
            lines = f.readlines()
            matches = []
            for i, line in enumerate(lines, 1):
                if keyword.lower() in line.lower():
                    matches.append((i, line))
            
            if matches:
                print(f"\n{'='*60}")
                print(f"找到 {len(matches)} 个匹配项 (关键词: {keyword})")
                print(f"{'='*60}\n")
                for line_num, line in matches[-20:]:  # 显示最后20个匹配
                    print(f"第 {line_num} 行: {line.rstrip()}")
            else:
                print(f"未找到包含 '{keyword}' 的日志")
                
    except Exception as e:
        print(f"搜索日志失败: {e}")

if __name__ == '__main__':
    if len(sys.argv) > 1:
        if sys.argv[1] == 'error':
            view_logs('error', 100)
        elif sys.argv[1] == 'search' and len(sys.argv) > 2:
            search_logs(sys.argv[2])
        elif sys.argv[1].isdigit():
            view_logs('all', int(sys.argv[1]))
        else:
            print("用法:")
            print("  python view_logs.py           # 查看最后50行日志")
            print("  python view_logs.py 100       # 查看最后100行日志")
            print("  python view_logs.py error      # 查看错误日志")
            print("  python view_logs.py search 关键词  # 搜索日志")
    else:
        view_logs('all', 50)












