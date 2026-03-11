"""Apply Let's Encrypt SSL certificates for viva-luxe-life.top and deliveryandplate.top via Baota"""
import paramiko, glob, sys, time
sys.stdout.reconfigure(encoding='utf-8')

pem = glob.glob(r'C:\Users\Administrator\Desktop\**\awssg0306.pem', recursive=True)[0]
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
pkey = paramiko.RSAKey.from_private_key_file(pem)
ssh.connect('52.74.221.116', username='ubuntu', pkey=pkey, timeout=30)
print("SSH connected")

def run(cmd, timeout=60):
    print(f">>> {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    o = stdout.read().decode('utf-8', errors='replace').strip()
    e = stderr.read().decode('utf-8', errors='replace').strip()
    if o: print(o[:3000])
    if e and 'warning' not in e.lower(): print(f"STDERR: {e[:1000]}")
    return o

domains = ['viva-luxe-life.top', 'deliveryandplate.top']

# First check if certbot/acme is available
print("=== Checking SSL tools ===")
run("which certbot 2>/dev/null || which /root/.acme.sh/acme.sh 2>/dev/null || echo 'NO_TOOL'")
run("sudo ls /www/server/panel/vhost/cert/ 2>/dev/null")

# Check Baota's SSL method - usually uses acme.sh or certbot
run("sudo ls /root/.acme.sh/ 2>/dev/null | head -10 || echo 'No acme.sh'")
run("sudo /www/server/panel/pyenv/bin/python --version 2>/dev/null || echo 'No bt python'")

# Try using Baota's built-in SSL API
# First get Baota panel info
print("\n=== Baota panel info ===")
run("sudo cat /www/server/panel/data/default.pl 2>/dev/null || echo 'no port file'")
run("sudo cat /www/server/panel/data/admin_path.pl 2>/dev/null || echo 'no admin path'")

# Use acme.sh directly if available
print("\n=== Applying SSL certificates ===")
for domain in domains:
    print(f"\n{'='*50}")
    print(f"=== SSL for {domain} ===")
    
    cert_dir = f'/www/server/panel/vhost/cert/{domain}'
    
    # Method 1: Try acme.sh (most common on Baota)
    result = run(f"sudo /root/.acme.sh/acme.sh --issue -d {domain} -d www.{domain} --webroot /www/wwwroot/{domain} --force 2>&1", timeout=120)
    
    if 'Cert success' in result or 'BEGIN CERTIFICATE' in result:
        print(f"  Certificate issued successfully!")
        # Install cert
        run(f"sudo mkdir -p {cert_dir}")
        run(f"sudo /root/.acme.sh/acme.sh --install-cert -d {domain} --key-file {cert_dir}/privkey.pem --fullchain-file {cert_dir}/fullchain.pem --reloadcmd 'sudo nginx -s reload' 2>&1", timeout=30)
    elif 'not found' in result.lower() or 'no such file' in result.lower():
        print("  acme.sh not found, trying certbot...")
        # Method 2: Try certbot
        result2 = run(f"sudo certbot certonly --webroot -w /www/wwwroot/{domain} -d {domain} -d www.{domain} --non-interactive --agree-tos --email admin@{domain} --force-renewal 2>&1", timeout=120)
        
        if 'Successfully' in result2 or 'Congratulations' in result2:
            print(f"  Certbot success!")
            run(f"sudo mkdir -p {cert_dir}")
            run(f"sudo cp /etc/letsencrypt/live/{domain}/fullchain.pem {cert_dir}/fullchain.pem")
            run(f"sudo cp /etc/letsencrypt/live/{domain}/privkey.pem {cert_dir}/privkey.pem")
        elif 'not found' in result2.lower() or 'no such file' in result2.lower():
            print("  certbot not found either, installing...")
            run("sudo apt-get update -qq && sudo apt-get install -y -qq certbot 2>&1 | tail -3", timeout=120)
            result3 = run(f"sudo certbot certonly --webroot -w /www/wwwroot/{domain} -d {domain} -d www.{domain} --non-interactive --agree-tos --email admin@{domain} 2>&1", timeout=120)
            if 'Successfully' in result3 or 'Congratulations' in result3:
                run(f"sudo mkdir -p {cert_dir}")
                run(f"sudo cp /etc/letsencrypt/live/{domain}/fullchain.pem {cert_dir}/fullchain.pem")
                run(f"sudo cp /etc/letsencrypt/live/{domain}/privkey.pem {cert_dir}/privkey.pem")
            else:
                print(f"  Failed: {result3[:500]}")
        else:
            print(f"  Certbot result: {result2[:500]}")
    else:
        # acme.sh ran but might have failed
        if 'error' in result.lower() or 'fail' in result.lower():
            print(f"  acme.sh failed, checking details...")
            # Maybe DNS not propagated yet, try standalone
            run(f"sudo /root/.acme.sh/acme.sh --issue -d {domain} -d www.{domain} --standalone --force 2>&1", timeout=120)
    
    # Verify cert
    print(f"\n  Verifying cert files...")
    run(f"sudo ls -la {cert_dir}/")
    run(f"sudo openssl x509 -in {cert_dir}/fullchain.pem -noout -subject -dates 2>/dev/null || echo 'No valid cert'")

# Reload nginx
print("\n=== Reloading nginx ===")
run("sudo nginx -t 2>&1")
run("sudo nginx -s reload 2>&1")

# Verify HTTPS
print("\n=== Verifying HTTPS ===")
for domain in domains:
    code = run(f'curl -s -o /dev/null -w "%{{http_code}}" https://{domain} --max-time 10 2>/dev/null || echo "FAIL"')
    print(f"  https://{domain} -> {code}")
    code2 = run(f'curl -s -o /dev/null -w "%{{http_code}}" https://www.{domain} --max-time 10 2>/dev/null || echo "FAIL"')
    print(f"  https://www.{domain} -> {code2}")

ssh.close()
print("\nDone!")
