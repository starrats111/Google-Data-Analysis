"""检查服务器上是否已安装宝塔面板"""
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

print("1. 检查宝塔面板是否安装...")
out, err = ssh_exec("bt default 2>/dev/null || /etc/init.d/bt default 2>/dev/null || echo 'NOT_INSTALLED'")
print(out or "未检测到")

print("\n2. 检查宝塔相关路径...")
out, err = ssh_exec("ls -la /www/server/ 2>/dev/null; ls -la /www/wwwroot/ 2>/dev/null; echo '---'; which bt 2>/dev/null || echo 'bt not in PATH'")
print(out or "宝塔路径不存在")

print("\n3. 当前 Nginx 版本和状态...")
out, err = ssh_exec("nginx -v 2>&1; systemctl status nginx 2>/dev/null | head -5")
print(out)

print("\n4. 服务器系统信息...")
out, err = ssh_exec("cat /etc/os-release | head -5; free -h | head -2; df -h / | tail -1")
print(out)

print("\n5. 已有的网站域名 DNS 指向...")
out, err = ssh_exec("for d in aura-bloom.top allurahub.top bloomroots.top; do echo \"$d: $(dig +short $d 2>/dev/null || nslookup $d 2>/dev/null | grep Address | tail -1)\"; done")
print(out)
