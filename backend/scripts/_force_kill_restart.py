import paramiko, time, sys
sys.stdout.reconfigure(encoding='utf-8')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', username='admin', password='A123456', timeout=15)

def run(cmd, timeout=10):
    _, o, e = ssh.exec_command(cmd, timeout=timeout)
    out = o.read().decode('utf-8', errors='replace').strip()
    err = e.read().decode('utf-8', errors='replace').strip()
    if out: print(out[:2000])
    if err and 'warning' not in err.lower(): print(f'ERR: {err[:500]}')
    return out

# Kill by PID directly
print("=== Kill old processes ===")
run("kill -9 94044 94045 2>/dev/null || true")
run("pkill -9 -f 'uvicorn app.main' || true")
run("pkill -9 -f 'python -m uvicorn' || true")
time.sleep(3)

# Verify killed
ps = run("ps aux | grep uvicorn | grep -v grep")
port = run("ss -tlnp | grep 8000")
print(f"\nProcess: {ps or 'NONE'}")
print(f"Port 8000: {port or 'FREE'}")

if not port:
    print("\n=== Starting fresh ===")
    transport = ssh.get_transport()
    ch = transport.open_session()
    ch.exec_command(
        "cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && "
        "nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 "
        ">> /home/admin/backend.log 2>&1 &"
    )
    time.sleep(8)
    ps = run("ps aux | grep uvicorn | grep -v grep")
    port = run("ss -tlnp | grep 8000")
    if "uvicorn" in (ps or "") and port:
        print("\n✓ Backend restarted successfully!")
    else:
        print("\n✗ Still failing")
        run("tail -10 /home/admin/backend.log")
else:
    print("Port still occupied, trying fuser...")
    run("fuser -k 8000/tcp 2>/dev/null || true")
    time.sleep(2)
    port = run("ss -tlnp | grep 8000")
    print(f"Port after fuser: {port or 'FREE'}")
    if not port:
        transport = ssh.get_transport()
        ch = transport.open_session()
        ch.exec_command(
            "cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && "
            "nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 "
            ">> /home/admin/backend.log 2>&1 &"
        )
        time.sleep(8)
        ps = run("ps aux | grep uvicorn | grep -v grep")
        if "uvicorn" in (ps or ""):
            print("\n✓ Backend restarted!")
        else:
            print("\n✗ Failed")

ssh.close()
