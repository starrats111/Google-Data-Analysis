"""Fix nginx config for deliveryandplate.top - $host was eaten by shell"""
import paramiko, glob, sys
sys.stdout.reconfigure(encoding='utf-8')

pem = glob.glob(r'C:\Users\Administrator\Desktop\**\awssg0306.pem', recursive=True)[0]
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
pkey = paramiko.RSAKey.from_private_key_file(pem)
ssh.connect('52.74.221.116', username='ubuntu', pkey=pkey, timeout=30)

def run(cmd, timeout=30):
    print(f">>> {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    o = stdout.read().decode('utf-8', errors='replace').strip()
    e = stderr.read().decode('utf-8', errors='replace').strip()
    if o: print(o[:2000])
    if e: print(f'STDERR: {e[:500]}')
    return o

# Check current config
print("=== Current config ===")
run("sudo cat /www/server/panel/vhost/nginx/deliveryandplate.top.conf")

# Write correct config using Python SFTP instead of heredoc
import io
nginx_conf = """server {
    listen 80;
    server_name deliveryandplate.top www.deliveryandplate.top;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl ;
    http2 on;
    server_name deliveryandplate.top www.deliveryandplate.top;
    root /www/wwwroot/deliveryandplate.top;
    index index.html index.htm;

    ssl_certificate /www/server/panel/vhost/cert/deliveryandplate.top/fullchain.pem;
    ssl_certificate_key /www/server/panel/vhost/cert/deliveryandplate.top/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location / {
        try_files $uri $uri/ /index.html;
    }

    access_log /www/wwwlogs/deliveryandplate.top.log;
    error_log /www/wwwlogs/deliveryandplate.top.error.log;
}
"""

# Write via SFTP to temp, then sudo mv
sftp = ssh.open_sftp()
with sftp.file('/tmp/delivery_nginx.conf', 'w') as f:
    f.write(nginx_conf)
sftp.close()

run("sudo mv /tmp/delivery_nginx.conf /www/server/panel/vhost/nginx/deliveryandplate.top.conf")
run("sudo cat /www/server/panel/vhost/nginx/deliveryandplate.top.conf")

# Also fix viva-luxe-life.top config the same way
viva_conf = """server {
    listen 80;
    server_name viva-luxe-life.top www.viva-luxe-life.top;
    return 301 https://$host$request_uri;
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
        try_files $uri $uri/ /index.html;
    }

    access_log /www/wwwlogs/viva-luxe-life.top.log;
    error_log /www/wwwlogs/viva-luxe-life.top.error.log;
}
"""

sftp = ssh.open_sftp()
with sftp.file('/tmp/viva_nginx.conf', 'w') as f:
    f.write(viva_conf)
sftp.close()

run("sudo mv /tmp/viva_nginx.conf /www/server/panel/vhost/nginx/viva-luxe-life.top.conf")

# Test and reload
print("\n=== Testing and reloading ===")
run("sudo nginx -t 2>&1")
run("sudo nginx -s reload 2>&1")

# Verify both sites
print("\n=== Verification ===")
run('curl -s -o /dev/null -w "%{http_code}" https://localhost -k -H "Host: deliveryandplate.top"')
run('curl -s -o /dev/null -w "%{http_code}" https://localhost -k -H "Host: viva-luxe-life.top"')

ssh.close()
print("\nDone!")
