"""Test login API on the server"""
import paramiko
import sys

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, PORT, USER, PASS, timeout=10)

cmd = '''python3 -c "
import json, urllib.request, urllib.error
data = json.dumps({'username':'admin','password':'admin123','role':'admin'}).encode()
req = urllib.request.Request('http://localhost:20050/api/auth/login', data=data, headers={'Content-Type':'application/json'})
try:
    resp = urllib.request.urlopen(req)
    print('STATUS:', resp.status)
    print('BODY:', resp.read().decode())
except urllib.error.HTTPError as e:
    print('STATUS:', e.code)
    print('BODY:', e.read().decode())
"'''

stdin, stdout, stderr = client.exec_command(cmd, timeout=30)
out = stdout.read().decode("utf-8", errors="replace")
err = stderr.read().decode("utf-8", errors="replace")
if out:
    sys.stdout.buffer.write(out.encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()
if err:
    sys.stdout.buffer.write(f"[STDERR] {err}".encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()

client.close()
