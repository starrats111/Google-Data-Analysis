"""Migrate deliveryandplate.top to Baota server"""
import paramiko, glob, sys
sys.stdout.reconfigure(encoding='utf-8')

BT_HOST = '52.74.221.116'
BT_USER = 'ubuntu'
pem = glob.glob(r'C:\Users\Administrator\Desktop\**\awssg0306.pem', recursive=True)[0]
DOMAIN = 'deliveryandplate.top'
SITE_DIR = f'/www/wwwroot/{DOMAIN}'
GITHUB_REPO = 'https://github.com/kydomain1/ParcelAndPlate.git'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
pkey = paramiko.RSAKey.from_private_key_file(pem)
ssh.connect(BT_HOST, username=BT_USER, pkey=pkey, timeout=30)
print("SSH connected")

def run(cmd, timeout=30):
    print(f">>> {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    o = stdout.read().decode('utf-8', errors='replace').strip()
    e = stderr.read().decode('utf-8', errors='replace').strip()
    if o: print(o[:2000])
    if e and 'WARNING' not in e and 'Cloning' not in e: print(f'STDERR: {e[:500]}')
    return o

# Step 1: Create site dir
result = run(f'sudo ls -la {SITE_DIR} 2>/dev/null || echo "NOT_FOUND"')
if 'NOT_FOUND' in result:
    print(f"\n=== Creating site directory ===")
    run(f'sudo mkdir -p {SITE_DIR}')

# Step 2: Clone repo
print(f"\n=== Cloning {GITHUB_REPO} ===")
run('rm -rf /tmp/delivery_clone')
run(f'git clone {GITHUB_REPO} /tmp/delivery_clone', timeout=60)
run('ls -la /tmp/delivery_clone/')

# Step 3: Copy files
print(f"\n=== Copying files ===")
run(f'sudo cp -r /tmp/delivery_clone/* {SITE_DIR}/')
run(f'sudo cp -r /tmp/delivery_clone/.* {SITE_DIR}/ 2>/dev/null; true')

# Step 4: Check structure
print(f"\n=== Site structure ===")
run(f'ls -la {SITE_DIR}/')
run(f'ls -la {SITE_DIR}/js/')
run(f'ls -la {SITE_DIR}/css/')
run(f'ls -la {SITE_DIR}/images/')

# Step 5: Set permissions
print(f"\n=== Setting permissions ===")
run(f'sudo chown -R www:www {SITE_DIR}')
run(f'sudo chmod -R 755 {SITE_DIR}')

# Step 6: Create Nginx config
result = run(f'sudo cat /www/server/panel/vhost/nginx/{DOMAIN}.conf 2>/dev/null || echo "NO_CONFIG"')
if 'NO_CONFIG' in result:
    print(f"\n=== Creating Nginx config ===")
    nginx_conf = """server {
    listen 80;
    server_name DOMAIN_PH www.DOMAIN_PH;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl ;
    http2 on;
    server_name DOMAIN_PH www.DOMAIN_PH;
    root SITE_DIR_PH;
    index index.html index.htm;

    ssl_certificate /www/server/panel/vhost/cert/DOMAIN_PH/fullchain.pem;
    ssl_certificate_key /www/server/panel/vhost/cert/DOMAIN_PH/privkey.pem;
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

    access_log /www/wwwlogs/DOMAIN_PH.log;
    error_log /www/wwwlogs/DOMAIN_PH.error.log;
}""".replace('DOMAIN_PH', DOMAIN).replace('SITE_DIR_PH', SITE_DIR)
    
    run(f"sudo bash -c 'cat > /www/server/panel/vhost/nginx/{DOMAIN}.conf << ENDOFCONF\n{nginx_conf}\nENDOFCONF'")
    
    # Create cert dir and self-signed cert
    run(f'sudo mkdir -p /www/server/panel/vhost/cert/{DOMAIN}')
    run(f'sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout /www/server/panel/vhost/cert/{DOMAIN}/privkey.pem -out /www/server/panel/vhost/cert/{DOMAIN}/fullchain.pem -subj "/CN={DOMAIN}" 2>&1')
else:
    print(f"\n=== Nginx config already exists ===")

# Step 7: Test and reload nginx
print(f"\n=== Reloading Nginx ===")
run('sudo nginx -t 2>&1')
run('sudo nginx -s reload 2>&1')

# Step 8: Verify
print(f"\n=== Verification ===")
run(f'curl -s -o /dev/null -w "%{{http_code}}" http://localhost -H "Host: {DOMAIN}"')
run(f'curl -s -o /dev/null -w "%{{http_code}}" https://localhost -k -H "Host: {DOMAIN}"')

# Cleanup
run('rm -rf /tmp/delivery_clone')

ssh.close()
print(f"\n=== {DOMAIN} migration complete ===")
