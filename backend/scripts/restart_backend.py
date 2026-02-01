#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
重启后端服务器 (Python脚本 - 跨平台)
使用方法: python restart_backend.py
"""
import os
import sys
import time
import subprocess
import signal
import platform
from pathlib import Path

def find_backend_dir():
    """查找backend目录"""
    script_dir = Path(__file__).parent
    backend_dir = script_dir.parent
    return backend_dir

def stop_existing_server(backend_dir):
    """停止现有的服务器进程"""
    print("=== 停止现有服务器 ===")
    
    system = platform.system()
    port = 8000
    
    if system == "Windows":
        # Windows: 查找占用8000端口的进程
        try:
            result = subprocess.run(
                ['netstat', '-ano'],
                capture_output=True,
                text=True,
                check=False
            )
            for line in result.stdout.split('\n'):
                if f':{port}' in line and 'LISTENING' in line:
                    parts = line.split()
                    if len(parts) > 4:
                        pid = parts[-1]
                        try:
                            subprocess.run(['taskkill', '/F', '/PID', pid], 
                                         capture_output=True, check=False)
                            print(f"  已停止进程: {pid}")
                        except:
                            pass
        except:
            pass
    else:
        # Linux/Mac: 使用lsof或fuser查找进程
        try:
            # 尝试使用lsof
            result = subprocess.run(
                ['lsof', '-ti', f':{port}'],
                capture_output=True,
                text=True,
                check=False
            )
            if result.stdout.strip():
                pids = result.stdout.strip().split('\n')
                for pid in pids:
                    try:
                        os.kill(int(pid), signal.SIGTERM)
                        print(f"  已停止进程: {pid}")
                    except:
                        pass
        except:
            # 尝试使用fuser
            try:
                subprocess.run(['fuser', '-k', f'{port}/tcp'], 
                             capture_output=True, check=False)
            except:
                pass
    
    # 额外尝试：查找uvicorn进程
    try:
        if system == "Windows":
            result = subprocess.run(
                ['tasklist', '/FI', 'IMAGENAME eq python.exe'],
                capture_output=True,
                text=True,
                check=False
            )
            # 这里可以进一步过滤uvicorn进程，但比较复杂
        else:
            result = subprocess.run(
                ['pgrep', '-f', 'uvicorn.*app.main'],
                capture_output=True,
                text=True,
                check=False
            )
            if result.stdout.strip():
                pids = result.stdout.strip().split('\n')
                for pid in pids:
                    try:
                        os.kill(int(pid), signal.SIGTERM)
                        print(f"  已停止uvicorn进程: {pid}")
                    except:
                        pass
    except:
        pass
    
    time.sleep(2)
    print("  停止完成")

def start_server(backend_dir):
    """启动服务器"""
    print("\n=== 启动服务器 ===")
    
    # 检查虚拟环境
    venv_dir = backend_dir / "venv"
    if not venv_dir.exists():
        print("错误: 虚拟环境不存在，请先创建虚拟环境")
        return False
    
    # 确定Python可执行文件路径
    system = platform.system()
    if system == "Windows":
        python_exe = venv_dir / "Scripts" / "python.exe"
    else:
        python_exe = venv_dir / "bin" / "python"
    
    if not python_exe.exists():
        python_exe = "python"
        print("警告: 使用系统Python，建议使用虚拟环境")
    
    # 启动命令
    cmd = [
        str(python_exe),
        "-m", "uvicorn",
        "app.main:app",
        "--host", "0.0.0.0",
        "--port", "8000"
    ]
    
    # 日志文件
    log_file = backend_dir / "run.log"
    
    try:
        # 启动进程
        if system == "Windows":
            # Windows: 使用CREATE_NO_WINDOW标志
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = subprocess.SW_HIDE
            
            with open(log_file, 'a', encoding='utf-8') as f:
                process = subprocess.Popen(
                    cmd,
                    cwd=str(backend_dir),
                    stdout=f,
                    stderr=subprocess.STDOUT,
                    startupinfo=startupinfo,
                    creationflags=subprocess.CREATE_NO_WINDOW
                )
        else:
            # Linux/Mac: 后台运行
            with open(log_file, 'a', encoding='utf-8') as f:
                process = subprocess.Popen(
                    cmd,
                    cwd=str(backend_dir),
                    stdout=f,
                    stderr=subprocess.STDOUT,
                    start_new_session=True
                )
        
        print(f"  服务器正在启动 (PID: {process.pid})...")
        time.sleep(3)
        return True
        
    except Exception as e:
        print(f"  启动失败: {e}")
        return False

def check_server_status():
    """检查服务器状态"""
    print("\n=== 检查服务器状态 ===")
    
    import urllib.request
    import urllib.error
    
    try:
        url = "http://127.0.0.1:8000/health"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as response:
            if response.status == 200:
                print("✓ 后端服务器启动成功")
                print("  访问地址: http://127.0.0.1:8000")
                print("  API文档: http://127.0.0.1:8000/docs")
                return True
    except Exception as e:
        print(f"✗ 后端服务器启动失败或未响应: {e}")
        return False

def main():
    """主函数"""
    print("=== 重启后端服务器 ===\n")
    
    # 切换到backend目录
    backend_dir = find_backend_dir()
    os.chdir(backend_dir)
    print(f"工作目录: {backend_dir}\n")
    
    # 停止现有服务器
    stop_existing_server(backend_dir)
    
    # 启动服务器
    if not start_server(backend_dir):
        print("\n重启失败，请检查错误信息")
        sys.exit(1)
    
    # 检查状态
    if check_server_status():
        print("\n=== 重启完成 ===")
    else:
        log_file = backend_dir / "run.log"
        if log_file.exists():
            print(f"\n查看日志文件: {log_file}")
            print("\n最近20行日志:")
            try:
                with open(log_file, 'r', encoding='utf-8') as f:
                    lines = f.readlines()
                    for line in lines[-20:]:
                        print(f"  {line.rstrip()}")
            except:
                pass
        print("\n=== 重启完成（但服务器可能未完全启动） ===")

if __name__ == "__main__":
    main()

