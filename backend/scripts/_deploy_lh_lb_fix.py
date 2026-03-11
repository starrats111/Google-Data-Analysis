"""
部署 LH(post_form) + LB(extra_params type=json) 修复到服务器并重启
"""
import paramiko
import time
import sys

HOST = "47.239.193.33"
USER = "admin"
PASS = "A123456"
PROJECT = "/home/admin/Google-Data-Analysis"

def ssh_exec(ssh, cmd, timeout=60):
    print(f"  > {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace")
    if out.strip():
        print(out.strip()[:2000])
    if err.strip():
        print(f"  [stderr] {err.strip()[:1000]}")
    return out, err

def main():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, username=USER, password=PASS, timeout=15)
    print("=== 已连接服务器 ===")

    # 1. Git pull
    print("\n--- 1. Git Pull ---")
    ssh_exec(ssh, f"cd {PROJECT} && git stash && git pull origin main")

    # 2. 验证关键修改
    print("\n--- 2. 验证 LH mode 和 LB extra_params ---")
    ssh_exec(ssh, f'cd {PROJECT} && grep -A2 \'"LH":\' backend/app/services/merchant_platform_sync.py | head -5')
    ssh_exec(ssh, f'cd {PROJECT} && grep -A8 \'"LB":\' backend/app/services/merchant_platform_sync.py | head -10')
    ssh_exec(ssh, f'cd {PROJECT} && grep "extra_params" backend/app/services/campaign_link_sync_service.py')

    # 3. 重启服务
    print("\n--- 3. 重启 uvicorn ---")
    ssh_exec(ssh, "pkill -9 -f uvicorn || true")
    time.sleep(2)
    ssh_exec(ssh, "fuser -k 8000/tcp 2>/dev/null || true")
    time.sleep(1)
    restart_cmd = (
        f"cd {PROJECT}/backend && "
        f"source /home/admin/Google-Data-Analysis/venv/bin/activate && "
        f"nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 "
        f"--workers 2 --timeout-keep-alive 120 "
        f"> /home/admin/Google-Data-Analysis/nohup.out 2>&1 &"
    )
    ssh_exec(ssh, restart_cmd)
    time.sleep(5)

    # 4. 健康检查
    print("\n--- 4. 健康检查 ---")
    ssh_exec(ssh, "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/api/health || echo 'FAIL'")
    
    # 5. 快速测试 LB API
    print("\n--- 5. 快速测试 LB API (带 type=json) ---")
    test_script = """
import sys
sys.path.insert(0, '/home/admin/Google-Data-Analysis/backend')
from app.services.merchant_platform_sync import PLATFORM_API_CONFIG
cfg = PLATFORM_API_CONFIG.get("LB", {})
print(f"LB config: mode={cfg.get('mode')}, extra_params={cfg.get('extra_params')}")
cfg_lh = PLATFORM_API_CONFIG.get("LH", {})
print(f"LH config: mode={cfg_lh.get('mode')}")
"""
    sftp = ssh.open_sftp()
    with sftp.file("/tmp/_test_config.py", "w") as f:
        f.write(test_script)
    sftp.close()
    ssh_exec(ssh, f"cd {PROJECT}/backend && source ../venv/bin/activate && python /tmp/_test_config.py")

    print("\n=== 部署完成 ===")
    ssh.close()

if __name__ == "__main__":
    main()
