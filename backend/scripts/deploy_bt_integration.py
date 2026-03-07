"""
CR-035 宝塔集成部署脚本
在阿里云 ECS 上执行：
1. 拉取最新代码
2. 配置 .env 中的宝塔 SSH 信息
3. 生成 SSH 密钥对（如果不存在）
4. 更新数据库中 aura-bloom.top 的 site_path
5. 重启后端服务
"""
import paramiko
import sys
import time

ECS_HOST = "47.239.193.33"
ECS_PORT = 22
ECS_USER = "admin"
ECS_PASS = "A123456"

BT_HOST = "52.74.221.116"
BT_USER = "ubuntu"

def ssh_exec(ssh, cmd, timeout=30):
    """执行命令并返回输出"""
    print(f"  > {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace").strip()
    err = stderr.read().decode("utf-8", errors="replace").strip()
    if out:
        print(f"    {out[:500]}")
    if err and "warning" not in err.lower():
        print(f"    [stderr] {err[:300]}")
    return out, err

def main():
    print("=" * 60)
    print("CR-035 宝塔集成部署")
    print("=" * 60)

    # 连接 ECS
    print("\n[1/6] 连接阿里云 ECS...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(ECS_HOST, ECS_PORT, ECS_USER, ECS_PASS, timeout=15)
    print("  ✓ 已连接")

    # 拉取最新代码
    print("\n[2/6] 拉取最新代码...")
    ssh_exec(ssh, "cd ~/Google-Data-Analysis && git stash && git pull origin main")

    # 生成 SSH 密钥（如果不存在）
    print("\n[3/6] 检查/生成 SSH 密钥...")
    out, _ = ssh_exec(ssh, "test -f ~/.ssh/id_rsa && echo EXISTS || echo MISSING")
    if "MISSING" in out:
        print("  生成新密钥对...")
        ssh_exec(ssh, 'ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa -N "" -q')
    
    # 获取公钥
    pub_key, _ = ssh_exec(ssh, "cat ~/.ssh/id_rsa.pub")
    print(f"  公钥: {pub_key[:80]}...")

    # 配置 .env
    print("\n[4/6] 更新 .env 配置...")
    env_additions = f"""
# ===== 宝塔服务器 SSH 配置（CR-035）=====
BT_SSH_HOST={BT_HOST}
BT_SSH_PORT=22
BT_SSH_USER={BT_USER}
BT_SSH_KEY_PATH=/home/admin/.ssh/id_rsa
BT_SSH_PASSWORD=
BT_SITE_ROOT=/www/wwwroot
"""
    # 先检查是否已有 BT_SSH_HOST
    out, _ = ssh_exec(ssh, "grep -c 'BT_SSH_HOST' ~/Google-Data-Analysis/backend/.env || echo 0")
    if out.strip() == "0":
        # 追加配置
        ssh_exec(ssh, f"cat >> ~/Google-Data-Analysis/backend/.env << 'ENVEOF'\n{env_additions}\nENVEOF")
        print("  ✓ 已追加宝塔 SSH 配置")
    else:
        # 更新现有配置
        ssh_exec(ssh, f"sed -i 's|^BT_SSH_HOST=.*|BT_SSH_HOST={BT_HOST}|' ~/Google-Data-Analysis/backend/.env")
        ssh_exec(ssh, f"sed -i 's|^BT_SSH_USER=.*|BT_SSH_USER={BT_USER}|' ~/Google-Data-Analysis/backend/.env")
        ssh_exec(ssh, "sed -i 's|^BT_SSH_KEY_PATH=.*|BT_SSH_KEY_PATH=/home/admin/.ssh/id_rsa|' ~/Google-Data-Analysis/backend/.env")
        print("  ✓ 已更新宝塔 SSH 配置")

    # 更新数据库中 aura-bloom.top 的 site_path
    print("\n[5/6] 更新数据库中的站点路径...")
    db_cmd = """cd ~/Google-Data-Analysis/backend && python3 -c "
import sqlite3
conn = sqlite3.connect('google_analysis.db')
c = conn.cursor()
# 更新 aura-bloom.top 的 site_path 为宝塔路径
c.execute(\\\"UPDATE pub_sites SET site_path='/www/wwwroot/aura-bloom.top', data_js_path='assets/js/main.js', article_template='' WHERE domain='aura-bloom.top'\\\")
rows = c.rowcount
conn.commit()
# 查看当前站点
c.execute(\\\"SELECT id, site_name, domain, site_path, data_js_path FROM pub_sites\\\")
for row in c.fetchall():
    print(f'  站点 {row[0]}: {row[1]} | {row[2]} | {row[3]} | {row[4]}')
conn.close()
print(f'更新了 {rows} 条记录')
"
"""
    ssh_exec(ssh, db_cmd)

    # 重启后端
    print("\n[6/6] 重启后端服务...")
    ssh_exec(ssh, "pkill -f 'uvicorn app.main' || true")
    time.sleep(2)
    ssh_exec(ssh, "cd ~/Google-Data-Analysis/backend && nohup python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 > /tmp/uvicorn.log 2>&1 &")
    time.sleep(3)
    out, _ = ssh_exec(ssh, "curl -s http://localhost:8000/health")
    if "ok" in out:
        print("  ✓ 后端服务已启动")
    else:
        print("  ⚠ 后端可能未完全启动，检查日志...")
        ssh_exec(ssh, "tail -20 /tmp/uvicorn.log")

    print("\n" + "=" * 60)
    print("部署完成！")
    print(f"\n⚠ 重要：需要将以下公钥添加到宝塔服务器 ({BT_HOST}) 的 {BT_USER} 用户:")
    print(f"\n{pub_key}")
    print(f"\n在宝塔服务器上执行:")
    print(f"  mkdir -p /home/{BT_USER}/.ssh")
    print(f"  echo '{pub_key}' >> /home/{BT_USER}/.ssh/authorized_keys")
    print(f"  chmod 700 /home/{BT_USER}/.ssh")
    print(f"  chmod 600 /home/{BT_USER}/.ssh/authorized_keys")
    print(f"  chown -R {BT_USER}:{BT_USER} /home/{BT_USER}/.ssh")
    print("=" * 60)

    ssh.close()

if __name__ == "__main__":
    main()
