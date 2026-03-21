"""Configure Nginx for google-data-analysis.top on the server"""
import paramiko
import sys

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

NGINX_CONFIG = """server {
    listen 80;
    server_name google-data-analysis.top www.google-data-analysis.top;

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:20050;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE streaming support
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
        chunked_transfer_encoding on;
    }
}
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, PORT, USER, PASS, timeout=10)

# Upload nginx config
sftp = client.open_sftp()
with sftp.file("/tmp/google-data-analysis.top", "w") as f:
    f.write(NGINX_CONFIG)
sftp.close()

commands = [
    "sudo mv /tmp/google-data-analysis.top /etc/nginx/sites-enabled/google-data-analysis.top",
    "sudo nginx -t 2>&1",
    "sudo systemctl reload nginx",
    "echo NGINX_DONE",
    "curl -s -o /dev/null -w '%{http_code}' http://localhost:20050/user/login",
]

for cmd in commands:
    stdin, stdout, stderr = client.exec_command(cmd, timeout=10)
    out = stdout.read().decode("utf-8", errors="replace").strip()
    err = stderr.read().decode("utf-8", errors="replace").strip()
    if out:
        sys.stdout.buffer.write(f"[{cmd[:40]}] {out}\n".encode("utf-8", errors="replace"))
    if err:
        sys.stdout.buffer.write(f"[{cmd[:40]}] STDERR: {err}\n".encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()

client.close()
