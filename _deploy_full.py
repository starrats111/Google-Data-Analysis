"""
综合部署脚本：构建前端 + 部署后端修改 + 重启服务
修改的文件：
  后端:
    - backend/app/services/article_gen_service.py (prompt改造 + 链接后处理)
    - backend/app/services/merchant_crawler.py (反爬增强)
    - backend/app/services/humanizer_service.py (去AI味增强)
  前端:
    - frontend/src/components/PublishWizard/index.jsx (跳过标题选择)
"""
import paramiko
import os
import time
import subprocess
import sys

SERVER = '47.239.193.33'
PORT = 22
USER = 'admin'
PASS = 'A123456'
REMOTE_BASE = '/home/admin/Google-Data-Analysis'

LOCAL_BASE = os.path.dirname(os.path.abspath(__file__))

# 需要部署的后端文件（本地相对路径 → 远程路径）
BACKEND_FILES = [
    ('backend/app/services/article_gen_service.py', f'{REMOTE_BASE}/backend/app/services/article_gen_service.py'),
    ('backend/app/services/merchant_crawler.py', f'{REMOTE_BASE}/backend/app/services/merchant_crawler.py'),
    ('backend/app/services/humanizer_service.py', f'{REMOTE_BASE}/backend/app/services/humanizer_service.py'),
]

def run_cmd(cmd, cwd=None):
    print(f"[CMD] {cmd}")
    result = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True)
    if result.stdout:
        print(result.stdout[-500:])
    if result.returncode != 0:
        print(f"[ERROR] {result.stderr[-500:]}")
    return result.returncode == 0

def main():
    # ===== Step 1: 构建前端 =====
    print("=" * 60)
    print("[1/4] 构建前端...")
    print("=" * 60)
    frontend_dir = os.path.join(LOCAL_BASE, 'frontend')
    
    # 检查 node_modules
    if not os.path.exists(os.path.join(frontend_dir, 'node_modules')):
        print("[INFO] 安装前端依赖...")
        if not run_cmd('npm install', cwd=frontend_dir):
            print("[WARN] npm install 失败，尝试继续...")
    
    if not run_cmd('npm run build', cwd=frontend_dir):
        print("[ERROR] 前端构建失败!")
        # 继续部署后端
        print("[INFO] 跳过前端部署，继续部署后端...")
        frontend_built = False
    else:
        frontend_built = True
        print("[OK] 前端构建成功")

    # ===== Step 2: 连接服务器 =====
    print("\n" + "=" * 60)
    print("[2/4] 连接服务器...")
    print("=" * 60)
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(SERVER, port=PORT, username=USER, password=PASS, timeout=15)
    sftp = ssh.open_sftp()
    print(f"[OK] 已连接 {SERVER}")

    # ===== Step 3: 上传后端文件 =====
    print("\n" + "=" * 60)
    print("[3/4] 上传后端文件...")
    print("=" * 60)
    for local_rel, remote_path in BACKEND_FILES:
        local_path = os.path.join(LOCAL_BASE, local_rel)
        if not os.path.exists(local_path):
            print(f"[SKIP] 本地文件不存在: {local_path}")
            continue
        print(f"  上传 {local_rel} → {remote_path}")
        sftp.put(local_path, remote_path)
    print("[OK] 后端文件上传完成")

    # ===== Step 3b: 上传前端构建产物 =====
    if frontend_built:
        print("\n[3b] 上传前端构建产物...")
        dist_dir = os.path.join(frontend_dir, 'dist')
        remote_dist = f'{REMOTE_BASE}/frontend/dist'
        
        # 确保远程目录存在
        try:
            ssh.exec_command(f'mkdir -p {remote_dist}')
            time.sleep(0.5)
        except:
            pass
        
        # 递归上传 dist 目录
        uploaded = 0
        for root, dirs, files in os.walk(dist_dir):
            rel_root = os.path.relpath(root, dist_dir)
            remote_root = f'{remote_dist}/{rel_root}'.replace('\\', '/').replace('/.', '')
            
            # 创建远程目录
            try:
                sftp.stat(remote_root)
            except FileNotFoundError:
                try:
                    ssh.exec_command(f'mkdir -p {remote_root}')
                    time.sleep(0.3)
                except:
                    pass
            
            for f in files:
                local_f = os.path.join(root, f)
                remote_f = f'{remote_root}/{f}'
                try:
                    sftp.put(local_f, remote_f)
                    uploaded += 1
                except Exception as e:
                    print(f"  [WARN] 上传失败 {f}: {e}")
        
        print(f"[OK] 前端构建产物上传完成 ({uploaded} 个文件)")

    # ===== Step 4: 重启后端 =====
    print("\n" + "=" * 60)
    print("[4/4] 重启后端服务...")
    print("=" * 60)
    
    # Kill existing uvicorn
    stdin, stdout, stderr = ssh.exec_command("ps aux | grep uvicorn | grep -v grep | awk '{print $2}'")
    pids = stdout.read().decode().strip().split('\n')
    pids = [p.strip() for p in pids if p.strip()]
    if pids:
        pid_str = ' '.join(pids)
        print(f"  杀死现有 uvicorn 进程: {pid_str}")
        ssh.exec_command(f'kill -9 {pid_str}')
        time.sleep(2)
    
    # Start uvicorn in background
    start_cmd = (
        f'cd {REMOTE_BASE}/backend && '
        'source venv/bin/activate && '
        'nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 '
        '> /home/admin/backend.log 2>&1 &'
    )
    transport = ssh.get_transport()
    channel = transport.open_session()
    channel.exec_command(start_cmd)
    time.sleep(5)
    
    # 验证
    stdin, stdout, stderr = ssh.exec_command('ps aux | grep uvicorn | grep -v grep')
    result = stdout.read().decode()
    if 'uvicorn' in result:
        print("[OK] uvicorn 已启动")
        # 健康检查
        time.sleep(3)
        stdin, stdout, stderr = ssh.exec_command('curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health')
        code = stdout.read().decode().strip()
        print(f"  健康检查: HTTP {code}")
    else:
        print("[WARN] uvicorn 可能未启动，请手动检查")
        print("  查看日志: tail -50 /home/admin/backend.log")

    sftp.close()
    ssh.close()
    
    print("\n" + "=" * 60)
    print("部署完成!")
    print("=" * 60)

if __name__ == '__main__':
    main()
