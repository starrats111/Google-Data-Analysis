"""Quick check: quiblo and bloomroots full script tag list in all HTML files"""
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

for domain in ["quiblo.top", "bloomroots.top"]:
    root = f"/www/wwwroot/{domain}"
    print(f"\n=== {domain} ===")
    for html in ["index.html", "article.html", "articles.html", "category.html"]:
        scripts = r(f"grep -o 'src=\"[^\"]*\\.js[^\"]*\"' {root}/{html} 2>/dev/null")
        if scripts:
            print(f"  {html}: {scripts}")
        else:
            print(f"  {html}: no script tags or file not found")

bt.close()
