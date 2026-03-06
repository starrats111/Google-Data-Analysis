"""
OPT-012 部署脚本 v2 — 每步独立 SSH 连接 + 大重试间隔
上一轮已完成: pip install beautifulsoup4 lxml
本轮需要: git stash+pull, alembic, frontend build, backend restart
"""
import paramiko
import time
import sys
import traceback

HOST = '47.239.193.33'
USER = 'admin'
PASS = 'A123456'
PROJECT = '/home/admin/Google-Data-Analysis'
BACKEND = f'{PROJECT}/backend'
FRONTEND = f'{PROJECT}/frontend'


def run(desc, cmd, timeout=120, retries=5, retry_delay=10):
    print(f"\n{'='*50}")
    print(f"  {desc}")
    print(f"{'='*50}")
    for attempt in range(1, retries + 1):
        try:
            ssh = paramiko.SSHClient()
            ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            ssh.connect(HOST, port=22, username=USER, password=PASS,
                        timeout=30, banner_timeout=60, auth_timeout=30,
                        allow_agent=False, look_for_keys=False)
            stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
            out = stdout.read().decode(errors='replace').strip()
            err = stderr.read().decode(errors='replace').strip()
            ssh.close()
            if out:
                lines = out.split('\n')
                if len(lines) > 50:
                    print('\n'.join(lines[-50:]))
                else:
                    print(out)
            if err:
                err_lines = err.split('\n')
                important = [l for l in err_lines if any(w in l.lower() for w in ['error', 'fatal', 'fail', 'traceback', 'exception'])]
                if important:
                    print("WARN:", '\n'.join(important[:10]))
                elif len(err) < 300:
                    print(f"stderr: {err}")
            print(f"  [OK - attempt {attempt}]")
            return out
        except Exception as e:
            print(f"  attempt {attempt}/{retries} failed: {type(e).__name__}: {e}")
            try:
                ssh.close()
            except:
                pass
            if attempt < retries:
                wait = retry_delay * attempt
                print(f"  waiting {wait}s before retry...")
                time.sleep(wait)
    print(f"  FAILED after {retries} attempts")
    return ""


def main():
    print(f"OPT-012 Deploy v2 -> {HOST}")
    print(f"Time: {time.strftime('%Y-%m-%d %H:%M:%S')}")

    # Step 1: git stash + pull
    out = run("Step 1: Git stash & pull",
              f"cd {PROJECT} && git stash 2>&1 && git pull origin main 2>&1")
    if "fatal" in out.lower() and "stash" not in out.lower():
        print("FATAL: Git pull failed, aborting")
        return

    # Step 2: Alembic migration (luchu import已修复)
    run("Step 2: Alembic migration",
        f"cd {BACKEND} && source venv/bin/activate && python -m alembic upgrade head 2>&1")

    # Step 3: Frontend npm install + build
    run("Step 3: Frontend build",
        f"cd {FRONTEND} && npm install --legacy-peer-deps 2>&1 | tail -5 && npm run build 2>&1 | tail -20",
        timeout=240)

    # Step 4: Kill old backend
    run("Step 4: Kill old backend",
        "pkill -f 'uvicorn.*app.main' 2>/dev/null; echo KILLED; sleep 2; ps aux | grep uvicorn | grep -v grep || echo 'No uvicorn running'")

    time.sleep(5)

    # Step 5: Start new backend
    run("Step 5: Start backend",
        f"cd {BACKEND}; "
        f"nohup {BACKEND}/venv/bin/python3 -m uvicorn app.main:app "
        f"--host 0.0.0.0 --port 8000 --workers 1 "
        f"> {BACKEND}/backend.log 2>&1 & "
        f"echo 'Backend starting...'")

    print("\nWaiting 12s for backend startup...")
    time.sleep(12)

    # Step 6: Health check
    health = run("Step 6: Health check",
                 "curl -s -m 15 http://localhost:8000/health || echo 'HEALTH_FAILED'")

    # Step 7: Verify
    run("Step 7: Verify process",
        "ps aux | grep uvicorn | grep -v grep | head -5")

    # Step 8: Check log
    run("Step 8: Recent log",
        f"tail -25 {BACKEND}/backend.log")

    if health and "HEALTH_FAILED" not in health:
        print(f"\n{'='*50}")
        print("  OPT-012 DEPLOYED SUCCESSFULLY!")
        print(f"{'='*50}")
    else:
        print(f"\n{'='*50}")
        print("  WARNING: Health check issue — check log above")
        print(f"{'='*50}")


if __name__ == "__main__":
    main()
