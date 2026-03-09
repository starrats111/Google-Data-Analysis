"""深入排查：DNS、网站实际路径、MID 8005157 爬取"""
import paramiko

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

def ssh_exec(cmd, timeout=60):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, PORT, USER, PASS, timeout=10)
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    client.close()
    return out, err

print("=" * 60)
print("1. DNS: aura-bloom.top 解析到哪里？")
print("=" * 60)
out, err = ssh_exec("dig +short aura-bloom.top 2>/dev/null || nslookup aura-bloom.top 2>/dev/null | tail -5")
print(out or "(无法解析)")

print("\n" + "=" * 60)
print("2. 查看完整 Nginx 配置")
print("=" * 60)
out, err = ssh_exec("cat /etc/nginx/sites-available/api.google-data-analysis.top 2>/dev/null")
print(out[:3000] if out else "(文件不存在)")
out2, err2 = ssh_exec("ls -la /etc/nginx/sites-available/ 2>/dev/null")
print(out2)

print("\n" + "=" * 60)
print("3. 检查本机 IP")
print("=" * 60)
out, err = ssh_exec("curl -s ifconfig.me 2>/dev/null || hostname -I")
print(out)

print("\n" + "=" * 60)
print("4. 测试爬取 MID 8005157 对应的网站")
print("=" * 60)
out, err = ssh_exec("""cd /home/admin/Google-Data-Analysis/backend && python3 -c "
from app.services.campaign_link_service import CampaignLinkService
from app.database import SessionLocal
db = SessionLocal()
svc = CampaignLinkService(db)
# 查找 user_id=1 的平台
platforms = svc.get_user_platforms(1)
print('User 1 platforms:', platforms)
db.close()
" 2>&1 | head -20""")
print(out)
if err:
    print("ERR:", err[:500])

print("\n" + "=" * 60)
print("5. 直接搜索日志中的所有爬取相关 URL")
print("=" * 60)
out, err = ssh_exec("grep -oP 'url=https?://[^ ,\"]+' /tmp/uvicorn.log 2>/dev/null | sort -u | tail -20")
print(out or "(未找到)")

print("\n" + "=" * 60)
print("6. 完整日志最后500行（过滤所有API请求）")
print("=" * 60)
out, err = ssh_exec("tail -500 /tmp/uvicorn.log 2>/dev/null | grep -E 'POST|ERROR|WARNING|crawl|publish|image' | tail -30")
print(out or "(未找到)")

print("\n" + "=" * 60)
print("7. 测试直接爬取 - 找 8005157 的网站 URL")
print("=" * 60)
out, err = ssh_exec("""cd /home/admin/Google-Data-Analysis/backend && python3 -c "
from app.database import SessionLocal
from app.models.affiliate import AffiliateMerchant
db = SessionLocal()
m = db.query(AffiliateMerchant).filter(AffiliateMerchant.merchant_id == '8005157').first()
if m:
    print(f'Found: name={m.merchant_name}, url={m.site_url}, platform={m.platform_code}')
else:
    print('MID 8005157 not found in DB')
    # 搜索类似的
    ms = db.query(AffiliateMerchant).filter(AffiliateMerchant.merchant_id.like('%8005%')).all()
    for x in ms:
        print(f'  Similar: mid={x.merchant_id}, name={x.merchant_name}, url={x.site_url}')
db.close()
" 2>&1""")
print(out)
if err:
    print("ERR:", err[:500])

print("\n" + "=" * 60)
print("8. 查看 AuraBloom 网站实际内容")
print("=" * 60)
out, err = ssh_exec("curl -sI https://aura-bloom.top 2>/dev/null | head -20")
print(out or "(无法访问)")
