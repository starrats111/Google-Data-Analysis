"""Migrate viva-luxe-life.top to Baota server"""
import paramiko, time, json, glob

BT_HOST = '52.74.221.116'
BT_USER = 'ubuntu'
_pem_files = glob.glob(r'C:\Users\Administrator\Desktop\**\awssg0306.pem', recursive=True)
BT_KEY = _pem_files[0] if _pem_files else r'C:\Users\Administrator\Desktop\密钥\awssg0306.pem'
DOMAIN = 'viva-luxe-life.top'
SITE_DIR = f'/www/wwwroot/{DOMAIN}'
GITHUB_REPO = 'https://github.com/kagetsu12/VivaLuxelife.git'

def ssh_exec(ssh, cmd, timeout=30):
    print(f">>> {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    if out.strip():
        print(out.strip()[:2000])
    if err.strip() and 'WARNING' not in err:
        print(f"STDERR: {err.strip()[:1000]}")
    return out.strip()

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
pkey = paramiko.RSAKey.from_private_key_file(BT_KEY)
ssh.connect(BT_HOST, username=BT_USER, pkey=pkey, timeout=30)
print("SSH connected")

# Step 1: Check if site dir already exists
result = ssh_exec(ssh, f'sudo ls -la {SITE_DIR} 2>/dev/null || echo "NOT_FOUND"')
if 'NOT_FOUND' in result:
    print(f"\n=== Creating site directory ===")
    ssh_exec(ssh, f'sudo mkdir -p {SITE_DIR}')
else:
    print(f"\n=== Site directory already exists ===")

# Step 2: Clone repo
print(f"\n=== Cloning {GITHUB_REPO} ===")
ssh_exec(ssh, f'rm -rf /tmp/viva_clone')
ssh_exec(ssh, f'git clone {GITHUB_REPO} /tmp/viva_clone', timeout=60)
ssh_exec(ssh, f'ls -la /tmp/viva_clone/')

# Step 3: Copy files to site dir
print(f"\n=== Copying files to {SITE_DIR} ===")
ssh_exec(ssh, f'sudo cp -r /tmp/viva_clone/* {SITE_DIR}/')
ssh_exec(ssh, f'sudo cp -r /tmp/viva_clone/.gitignore {SITE_DIR}/ 2>/dev/null; true')

# Step 4: Check site structure
print(f"\n=== Site structure ===")
ssh_exec(ssh, f'ls -la {SITE_DIR}/')
ssh_exec(ssh, f'ls -la {SITE_DIR}/js/ 2>/dev/null || echo "No js dir"')
ssh_exec(ssh, f'ls -la {SITE_DIR}/css/ 2>/dev/null || echo "No css dir"')
ssh_exec(ssh, f'ls -la {SITE_DIR}/articles/ 2>/dev/null || echo "No articles dir"')

# Step 5: Check if index.html exists
result = ssh_exec(ssh, f'head -20 {SITE_DIR}/index.html')
print(f"\n=== index.html head ===")

# Step 6: Set permissions
print(f"\n=== Setting permissions ===")
ssh_exec(ssh, f'sudo chown -R www:www {SITE_DIR}')
ssh_exec(ssh, f'sudo chmod -R 755 {SITE_DIR}')

# Step 7: Check existing Nginx configs for reference
print(f"\n=== Checking existing sites ===")
ssh_exec(ssh, f'sudo ls /www/server/panel/vhost/nginx/')

# Step 8: Get a reference config
print(f"\n=== Getting reference config ===")
ref = ssh_exec(ssh, f'sudo cat /www/server/panel/vhost/nginx/bloomroots.top.conf 2>/dev/null || sudo cat /www/server/panel/vhost/nginx/vitahaven.click.conf 2>/dev/null || echo "NO_REF"')

# Step 9: Check if Nginx config already exists for this domain
result = ssh_exec(ssh, f'sudo cat /www/server/panel/vhost/nginx/{DOMAIN}.conf 2>/dev/null || echo "NO_CONFIG"')
if 'NO_CONFIG' in result:
    print(f"\n=== Creating Nginx config ===")
    
    nginx_conf = """server {
    listen 80;
    listen 443 ssl http2;
    server_name DOMAIN_PH www.DOMAIN_PH;
    index index.html index.htm;
    root SITE_DIR_PH;

    ssl_certificate /www/server/panel/vhost/cert/DOMAIN_PH/fullchain.pem;
    ssl_certificate_key /www/server/panel/vhost/cert/DOMAIN_PH/privkey.pem;
    ssl_protocols TLSv1.1 TLSv1.2 TLSv1.3;
    ssl_ciphers EECDH+CHACHA20:EECDH+CHACHA20-draft:EECDH+AES128:RSA+AES128:EECDH+AES256:RSA+AES256:EECDH+3DES:RSA+3DES:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_timeout 10m;
    ssl_session_cache builtin:1000 shared:SSL:10m;

    error_page 404 /404.html;

    gzip on;
    gzip_min_length 1k;
    gzip_comp_level 4;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;

    location ~* \\.(jpg|jpeg|gif|png|css|js|ico|xml)$ {
        expires 30d;
        add_header Cache-Control "public, no-transform";
    }

    location ~ /\\. {
        deny all;
    }

    access_log /www/wwwlogs/DOMAIN_PH.log;
    error_log /www/wwwlogs/DOMAIN_PH.error.log;
}""".replace('DOMAIN_PH', DOMAIN).replace('SITE_DIR_PH', SITE_DIR)
    
    # Write config via heredoc
    ssh_exec(ssh, f"sudo bash -c 'cat > /www/server/panel/vhost/nginx/{DOMAIN}.conf << ENDOFCONF\n{nginx_conf}\nENDOFCONF'")
    
    # Create cert directory
    ssh_exec(ssh, f'sudo mkdir -p /www/server/panel/vhost/cert/{DOMAIN}')
    
    # Create self-signed cert for initial setup
    ssh_exec(ssh, f'sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout /www/server/panel/vhost/cert/{DOMAIN}/privkey.pem -out /www/server/panel/vhost/cert/{DOMAIN}/fullchain.pem -subj "/CN={DOMAIN}" 2>&1')
else:
    print(f"\n=== Nginx config already exists ===")

# Step 10: Test and reload nginx
print(f"\n=== Testing Nginx config ===")
ssh_exec(ssh, 'sudo nginx -t 2>&1')
ssh_exec(ssh, 'sudo systemctl reload nginx 2>&1 || sudo nginx -s reload 2>&1')

# Step 11: Verify
print(f"\n=== Verifying site ===")
ssh_exec(ssh, f'curl -s -o /dev/null -w "%{{http_code}}" http://localhost -H "Host: {DOMAIN}"')

# Cleanup
ssh_exec(ssh, 'rm -rf /tmp/viva_clone')

ssh.close()
print("\n=== viva-luxe-life.top migration complete ===")
