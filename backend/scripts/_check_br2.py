"""Check bloomroots script.js article loading logic"""
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

br = "/www/wwwroot/bloomroots.top"

# Get loadArticleByTitle and surrounding context
print("=== script.js lines 125-280 ===")
print(r(f"sed -n '125,280p' {br}/script.js"))

print("\n=== Check if articlesData is referenced ===")
print(r(f"grep -n 'articlesData' {br}/script.js"))

print("\n=== articles-index.js tail ===")
print(r(f"tail -10 {br}/js/articles-index.js"))

bt.close()
