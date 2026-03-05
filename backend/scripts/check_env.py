import paramiko, time

HOST = '47.239.193.33'
USER = 'admin'
PASS = 'A123456'

def run(desc, cmd, timeout=30, retries=3):
    print(f"\n[{desc}]")
    for attempt in range(retries):
        try:
            ssh = paramiko.SSHClient()
            ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            ssh.connect(HOST, port=22, username=USER, password=PASS, timeout=15, banner_timeout=30)
            stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
            out = stdout.read().decode().strip()
            err = stderr.read().decode().strip()
            if out: print(out)
            if err: print(f"STDERR: {err}")
            ssh.close()
            return out
        except Exception as e:
            print(f"  Attempt {attempt+1} failed: {e}")
            time.sleep(3)
    return ""

# Check env file for gemini config
run("Check gemini config in .env", 
    "grep -i 'gemini' /home/admin/Google-Data-Analysis/backend/.env")

# Check current article_gen_service fallback models
run("Check current fallback models",
    "grep 'FALLBACK' /home/admin/Google-Data-Analysis/backend/app/services/article_gen_service.py")
