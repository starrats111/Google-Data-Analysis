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
            if not out and not err: print("(ok)")
            ssh.close()
            return out
        except Exception as e:
            print(f"  Attempt {attempt+1} failed: {e}")
            time.sleep(3)
    return ""

# 1. 直接在服务器上修改 fallback 模型
run("修改 fallback 模型",
    r"""sed -i 's/FALLBACK_MODELS = \["gemini-1.5-flash", "gemini-1.5-pro"\]/FALLBACK_MODELS = ["\[福利\]gemini-3-flash-preview", "\[福利\]gemini-3-flash-preview-thinking"]/' /home/admin/Google-Data-Analysis/backend/app/services/article_gen_service.py""")

# 2. 验证修改
run("验证修改", "grep 'FALLBACK' /home/admin/Google-Data-Analysis/backend/app/services/article_gen_service.py")

# 3. 重启后端
run("杀掉旧进程", "pkill -9 -f uvicorn; sleep 2; echo 'killed'")

time.sleep(2)

run("启动后端",
    "cd /home/admin/Google-Data-Analysis/backend; "
    "source venv/bin/activate; "
    "nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1 > /tmp/backend.log 2>&1 &"
)

print("\n[等待 8 秒...]")
time.sleep(8)

result = run("Health check", "curl -s -m 10 http://127.0.0.1:8000/health")

run("确认进程", "ps aux | grep uvicorn | grep -v grep")

if '"ok"' in (result or ''):
    print("\n✅ 后端重启成功，fallback 模型已更新")
else:
    print("\n⚠️ 检查启动日志")
    run("启动日志", "tail -20 /tmp/backend.log")
