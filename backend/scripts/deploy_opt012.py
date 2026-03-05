"""
OPT-012 部署脚本
1. 服务器 git pull
2. 安装新依赖 (beautifulsoup4, lxml)
3. 数据库迁移 (alembic)
4. 前端构建
5. 后端重启
6. 健康检查
"""
import paramiko
import time
import sys

HOST = '47.239.193.33'
USER = 'admin'
PASS = 'A123456'
PROJECT = '/home/admin/Google-Data-Analysis'
BACKEND = f'{PROJECT}/backend'
FRONTEND = f'{PROJECT}/frontend'


def run(desc, cmd, timeout=120):
    print(f"\n{'='*60}")
    print(f"[{desc}]")
    print(f"{'='*60}")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        ssh.connect(HOST, port=22, username=USER, password=PASS, timeout=15)
        stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode().strip()
        err = stderr.read().decode().strip()
        if out:
            print(out[-3000:] if len(out) > 3000 else out)
        if err:
            important = [l for l in err.split('\n') if 'error' in l.lower() or 'fatal' in l.lower() or 'fail' in l.lower()]
            if important:
                print(f"ERR: {chr(10).join(important)}")
            elif len(err) < 500:
                print(f"STDERR: {err}")
        ssh.close()
        return out
    except Exception as e:
        print(f"SSH ERROR: {e}")
        try:
            ssh.close()
        except:
            pass
        return ""


def main():
    print("OPT-012 Deployment Start")
    print(f"Server: {HOST}")

    # 1. Git pull
    out = run("Git Pull",
        f"cd {PROJECT} && git pull origin main 2>&1 || git pull 2>&1"
    )
    if "fatal" in out.lower():
        print("Git pull failed!")
        sys.exit(1)

    # 2. Install Python dependencies
    run("Install Python deps",
        f"cd {BACKEND} && source venv/bin/activate && pip install beautifulsoup4 lxml 2>&1 | tail -10"
    )

    # 3. Alembic migration
    run("Database migration",
        f"cd {BACKEND} && source venv/bin/activate && python -m alembic upgrade head 2>&1"
    )

    # 4. Frontend build
    run("Frontend build",
        f"cd {FRONTEND} && npm install --legacy-peer-deps 2>&1 | tail -5 && npm run build 2>&1 | tail -10",
        timeout=180
    )

    # 5. Kill old backend
    run("Kill old backend",
        "pkill -f 'uvicorn.*app.main' || echo 'No running process'"
    )
    print("\nWaiting 3s...")
    time.sleep(3)

    # 6. Start backend
    run("Start backend",
        f"cd {BACKEND}; "
        f"nohup {BACKEND}/venv/bin/python3 "
        f"-m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1 "
        f"> {BACKEND}/backend.log 2>&1 &"
    )
    print("\nWaiting 10s for startup...")
    time.sleep(10)

    # 7. Health check
    health = run("Health check",
        "curl -s -m 10 http://localhost:8000/health"
    )

    # 8. Verify process
    run("Verify process",
        "ps aux | grep uvicorn | grep -v grep"
    )

    # 9. Check log for errors
    run("Recent log (last 20 lines)",
        f"tail -20 {BACKEND}/backend.log"
    )

    # 10. Test new endpoints
    run("Test /crawl endpoint exists",
        "curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/api/article-gen/crawl"
    )

    if health and "error" not in health.lower():
        print("\n" + "="*60)
        print("OPT-012 DEPLOYED SUCCESSFULLY")
        print("="*60)
    else:
        print("\n" + "="*60)
        print("WARNING: Health check may have issues, check logs above")
        print("="*60)


if __name__ == "__main__":
    main()
