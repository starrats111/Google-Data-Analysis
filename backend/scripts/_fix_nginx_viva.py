"""Fix nginx config for viva-luxe-life.top and ensure nginx is running"""
import paramiko, glob

pem = glob.glob(r'C:\Users\Administrator\Desktop\**\awssg0306.pem', recursive=True)[0]
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
pkey = paramiko.RSAKey.from_private_key_file(pem)
ssh.connect('52.74.221.116', username='ubuntu', pkey=pkey, timeout=30)

def run(cmd):
    print(f">>> {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=30)
    o = stdout.read().decode('utf-8', errors='replace').strip()
    e = stderr.read().decode('utf-8', errors='replace').strip()
    if o: print(o[:1500])
    if e: print(f'STDERR: {e[:500]}')
    return o

# Write proper nginx config matching bloomroots.top style
run("""sudo bash -c 'cat > /www/server/panel/vhost/nginx/viva-luxe-life.top.conf << ENDOFCONF
server {
    listen 80;
    server_name viva-luxe-life.top www.viva-luxe-life.top;
    return 301 https://\\$host\\$request_uri;
}

server {
    listen 443 ssl ;
    http2 on;
    server_name viva-luxe-life.top www.viva-luxe-life.top;
    root /www/wwwroot/viva-luxe-life.top;
    index index.html index.htm;

    ssl_certificate /www/server/panel/vhost/cert/viva-luxe-life.top/fullchain.pem;
    ssl_certificate_key /www/server/panel/vhost/cert/viva-luxe-life.top/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location / {
        try_files \\$uri \\$uri/ /index.html;
    }

    access_log /www/wwwlogs/viva-luxe-life.top.log;
    error_log /www/wwwlogs/viva-luxe-life.top.error.log;
}
ENDOFCONF'""")

# Verify config was written
run("sudo cat /www/server/panel/vhost/nginx/viva-luxe-life.top.conf")

# Test nginx
run("sudo nginx -t 2>&1")

# Reload nginx properly
run("sudo systemctl daemon-reload 2>&1")
run("sudo systemctl start nginx 2>&1")
run("sudo systemctl reload nginx 2>&1 || sudo nginx -s reload 2>&1")

# Verify HTTP
print("\n=== Verification ===")
run('curl -s -o /dev/null -w "%{http_code}" http://localhost -H "Host: viva-luxe-life.top"')

ssh.close()
print("\nDone!")
