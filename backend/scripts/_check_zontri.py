"""Check zontri main.js for fetch"""
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

root = "/www/wwwroot/zontri.top"
print("=== grep fetch in main.js ===")
print(r(f"grep -n 'fetch' {root}/js/main.js | head -10"))
print("\n=== grep json in main.js ===")
print(r(f"grep -n '\\.json' {root}/js/main.js | head -10"))
print("\n=== grep articles.*json in main.js ===")
print(r(f"grep -n 'articles.*json\\|json.*articles' {root}/js/main.js | head -10"))
print("\n=== tail -30 main.js ===")
print(r(f"tail -30 {root}/js/main.js"))

bt.close()
