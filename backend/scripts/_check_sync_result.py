import paramiko, sys, json
sys.stdout.reconfigure(encoding='utf-8')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', username='admin', password='A123456', timeout=10)

stdin, stdout, stderr = ssh.exec_command('cat /tmp/resync_result.json 2>/dev/null', timeout=15)
out = stdout.read().decode('utf-8', errors='replace').strip()
if out:
    data = json.loads(out)
    status = data.get("status")
    print(f"Status: {status}")
    if status == "done":
        print(f"Before: {data['before_total']}")
        print(f"After: {data['after_total']} (+{data['diff']})")
        sr = data.get('sync_result', {})
        print(f"Users: {sr.get('total_users')}, Cached: {sr.get('total_cached')}, Errors: {sr.get('total_errors')}")
        for k in sorted(data.get('after', {}).keys()):
            b = data.get('before', {}).get(k, 0)
            a = data['after'][k]
            print(f"  {k}: {b} -> {a} ({a-b:+d})")
    elif status == "error":
        print(f"Error: {data.get('error')}")
    else:
        print(f"Still running. Before total: {data.get('before_total')}")
else:
    print("No result file yet")

stdin2, stdout2, stderr2 = ssh.exec_command('ps aux | grep full_resync | grep -v grep', timeout=5)
ps = stdout2.read().decode().strip()
if ps:
    print(f"\nProcess still running:\n{ps}")
else:
    print("\nProcess finished")

stdin3, stdout3, stderr3 = ssh.exec_command('tail -10 /tmp/resync_log.txt 2>/dev/null', timeout=10)
log = stdout3.read().decode('utf-8', errors='replace')
print(f"\nLog tail:\n{log}")

ssh.close()
