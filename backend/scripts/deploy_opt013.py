"""OPT-013 部署脚本：git pull + 前端构建 + 后端重启 + 创建 sites 目录"""
import paramiko
import time
import sys

SERVER = "47.239.193.33"
USER = "admin"
PASSWORD = "A123456"

def run_cmd(ssh, cmd, timeout=120):
    print(f"\n>>> {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    exit_code = stdout.channel.recv_exit_status()
    out = stdout.read().decode("utf-8", errors="replace").strip()
    err = stderr.read().decode("utf-8", errors="replace").strip()
    if out:
        print(out[-2000:] if len(out) > 2000 else out)
    if err:
        print(f"[STDERR] {err[-1000:]}")
    print(f"[EXIT CODE] {exit_code}")
    return exit_code, out

def ssh_connect_with_retry(server, user, password, retries=3):
    for attempt in range(1, retries + 1):
        try:
            ssh = paramiko.SSHClient()
            ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            print(f"[尝试 {attempt}/{retries}] 连接 {server}...")
            ssh.connect(server, port=22, username=user, password=password,
                        timeout=60, banner_timeout=60, auth_timeout=60,
                        allow_agent=False, look_for_keys=False)
            print("SSH 连接成功！")
            return ssh
        except Exception as e:
            print(f"[尝试 {attempt}] 失败: {e}")
            if attempt < retries:
                print("等待 5 秒后重试...")
                time.sleep(5)
            else:
                raise

def main():
    ssh = ssh_connect_with_retry(SERVER, USER, PASSWORD)

    # 1. git pull
    run_cmd(ssh, "cd /home/admin/Google-Data-Analysis && git pull origin main")

    # 2. 创建 sites 目录
    run_cmd(ssh, "mkdir -p /home/admin/sites && chmod 755 /home/admin/sites")

    # 3. 停止后端
    run_cmd(ssh, "pkill -f 'uvicorn.*app.main' || true")
    time.sleep(2)

    # 4. 启动后端
    run_cmd(ssh, "cd /home/admin/Google-Data-Analysis/backend && nohup python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 > /tmp/uvicorn.log 2>&1 & echo 'started'")
    time.sleep(4)

    # 5. 健康检查
    code, out = run_cmd(ssh, "curl -s http://localhost:8000/health")
    if '"ok"' in out:
        print("\n✅ 后端启动成功！")
    else:
        print("\n❌ 后端可能未启动，查看日志：")
        run_cmd(ssh, "tail -30 /tmp/uvicorn.log")
        ssh.close()
        sys.exit(1)

    # 6. 检查 DB 迁移
    code, out = run_cmd(ssh, "cat /tmp/uvicorn.log | grep -i 'pub_sites\\|OPT-013'")

    # 7. 构建前端
    print("\n开始构建前端（可能需要 1-2 分钟）...")
    code, out = run_cmd(ssh, "cd /home/admin/Google-Data-Analysis/frontend && npm run build", timeout=300)
    if code == 0:
        print("\n✅ 前端构建成功！")
    else:
        print("\n❌ 前端构建失败")

    # 8. 重启后端（加载新前端）
    run_cmd(ssh, "pkill -f 'uvicorn.*app.main' || true")
    time.sleep(2)
    run_cmd(ssh, "cd /home/admin/Google-Data-Analysis/backend && nohup python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 > /tmp/uvicorn.log 2>&1 & echo 'restarted'")
    time.sleep(4)
    code, out = run_cmd(ssh, "curl -s http://localhost:8000/health")
    if '"ok"' in out:
        print("\n✅ 全部部署完成！OPT-013 已上线。")
    else:
        print("\n⚠️ 最终健康检查未通过，请手动检查")
        run_cmd(ssh, "tail -30 /tmp/uvicorn.log")

    ssh.close()

if __name__ == "__main__":
    main()
