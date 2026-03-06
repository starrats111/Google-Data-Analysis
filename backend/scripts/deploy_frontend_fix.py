"""
前端构建修复 — 增加 Node.js 内存限制
"""
import paramiko
import time

HOST = '47.239.193.33'
USER = 'admin'
PASS = 'A123456'
FRONTEND = '/home/admin/Google-Data-Analysis/frontend'


def run(desc, cmd, timeout=300, retries=3):
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
                print('\n'.join(lines[-30:]))
            if err:
                err_lines = [l for l in err.split('\n') if any(w in l.lower() for w in ['error', 'fatal', 'fail', 'warn'])]
                if err_lines:
                    print('\n'.join(err_lines[:10]))
            print(f"  [OK - attempt {attempt}]")
            return out
        except Exception as e:
            print(f"  attempt {attempt}/{retries}: {e}")
            try:
                ssh.close()
            except:
                pass
            if attempt < retries:
                time.sleep(10 * attempt)
    return ""


def main():
    # 增加 Node.js 可用内存到 512MB，并构建
    out = run("Frontend build (512MB heap)",
        f"cd {FRONTEND} && "
        f"export NODE_OPTIONS='--max-old-space-size=512' && "
        f"npm run build 2>&1 | tail -20",
        timeout=300)

    if "build" in out.lower() or "compiled" in out.lower() or "webpack" in out.lower():
        print("\nFrontend build SUCCESS!")
    elif "FATAL" in out or "heap" in out.lower():
        print("\nStill OOM — trying with generate_sourcemap=false...")
        run("Frontend build (no sourcemap)",
            f"cd {FRONTEND} && "
            f"export NODE_OPTIONS='--max-old-space-size=512' && "
            f"GENERATE_SOURCEMAP=false npm run build 2>&1 | tail -20",
            timeout=300)
    else:
        print("\nCheck output above for details")


if __name__ == "__main__":
    main()
