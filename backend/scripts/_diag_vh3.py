"""Get vitahaven main.js article loading logic"""
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')
pkey = paramiko.RSAKey.from_private_key_file(r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem")
bt = paramiko.SSHClient()
bt.set_missing_host_key_policy(paramiko.AutoAddPolicy())
bt.connect("52.74.221.116", 22, "ubuntu", pkey=pkey, timeout=15)
def r(cmd, t=15):
    stdin, stdout, stderr = bt.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

vh = "/www/wwwroot/vitahaven.click"

# Get lines 190-240 of main.js
print("=== main.js lines 190-240 ===")
print(r(f"sed -n '190,240p' {vh}/js/main.js"))

# Also check the script load order issue
print("\n=== article.html script tags ===")
print(r(f"grep -n '<script' {vh}/article.html"))

# Check data.js script tag
print("\n=== data.js in article.html? ===")
print(r(f"grep -n 'data.js' {vh}/article.html"))

# Total lines in main.js
print(f"\n=== main.js total lines: {r(f'wc -l {vh}/js/main.js')} ===")

bt.close()
