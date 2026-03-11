import paramiko, time, sys
sys.stdout.reconfigure(encoding='utf-8')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', username='admin', password='A123456', timeout=15)

def run(cmd, timeout=10):
    _, o, e = ssh.exec_command(cmd, timeout=timeout)
    return o.read().decode('utf-8', errors='replace').strip()

# Check if running
ps = run("ps aux | grep uvicorn | grep -v grep")
if "uvicorn" in ps:
    print("✓ Already running:")
    print(ps)
else:
    print("Not running, starting...")
    transport = ssh.get_transport()
    ch = transport.open_session()
    ch.exec_command(
        "cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && "
        "nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 "
        ">> /home/admin/backend.log 2>&1 &"
    )
    time.sleep(8)
    ps = run("ps aux | grep uvicorn | grep -v grep")
    if "uvicorn" in ps:
        print("✓ Started!")
        print(ps)
    else:
        print("✗ Failed")
        print(run("tail -5 /home/admin/backend.log"))

# Port check
print("\nPort 8000:", run("ss -tlnp | grep 8000"))
ssh.close()
