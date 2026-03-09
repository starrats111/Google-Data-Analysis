"""深入排查：找到 AuraBloom 实际网站目录和 Nginx 配置"""
import paramiko

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

def ssh_exec(cmd, timeout=30):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, PORT, USER, PASS, timeout=10)
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    client.close()
    return out, err

print("=" * 60)
print("1. 找 Nginx 主配置文件中 aura-bloom 相关配置")
print("=" * 60)
out, err = ssh_exec("grep -rn 'aura' /etc/nginx/ 2>/dev/null || echo 'no match'")
print(out)
out, err = ssh_exec("cat /etc/nginx/nginx.conf 2>/dev/null | head -50")
print(out)

print("\n" + "=" * 60)
print("2. 列出所有 Nginx server block 文件")
print("=" * 60)
out, err = ssh_exec("ls -la /etc/nginx/sites-enabled/ 2>/dev/null; ls -la /etc/nginx/conf.d/ 2>/dev/null; find /etc/nginx/ -name '*.conf' 2>/dev/null")
print(out)

print("\n" + "=" * 60)
print("3. 找 AuraBloom 实际目录")
print("=" * 60)
out, err = ssh_exec("find /home/admin/ -iname '*aura*' -type d 2>/dev/null | head -20")
print(out or "(未找到)")

out, err = ssh_exec("find /var/www/ -iname '*aura*' -type d 2>/dev/null | head -10")
print(out or "(/var/www 中未找到)")

print("\n" + "=" * 60)
print("4. 查看 publisher 写的 articles-index.js 内容")
print("=" * 60)
out, err = ssh_exec("cat /home/admin/sites/aura-bloom-top/js/articles-index.js 2>/dev/null")
print(out[:2000] if out else "(文件不存在)")

print("\n" + "=" * 60)
print("5. 检查 Luchu 目录下是否有 AuraBloom")
print("=" * 60)
out, err = ssh_exec("ls -la /home/admin/Google-Data-Analysis/Luchu/ 2>/dev/null")
print(out)

print("\n" + "=" * 60)
print("6. 检查 MID 8005157 的爬取日志")
print("=" * 60)
out, err = ssh_exec("grep -i '8005157\\|fitness\\|nasm\\|issa\\|certified' /tmp/uvicorn.log 2>/dev/null | tail -20")
print(out or "(未找到)")

print("\n" + "=" * 60)
print("7. 检查最近的爬取错误日志")
print("=" * 60)
out, err = ssh_exec("grep -iE 'ERROR|WARNING|fail|error' /tmp/uvicorn.log 2>/dev/null | grep -i 'crawl\\|image\\|merchant' | tail -20")
print(out or "(未找到)")
