"""排查文章发布和图片爬取问题"""
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
print("1. 检查后端日志中的爬取和发布记录")
print("=" * 60)
out, err = ssh_exec("tail -500 /tmp/uvicorn.log 2>/dev/null | grep -iE 'crawl|publish|site_publisher|MerchantCrawler|slug|发布|图片|image-proxy' | tail -40")
print(out or "(无相关日志)")
if err:
    print("ERR:", err)

print("\n" + "=" * 60)
print("2. 查看 PubSite 表（网站配置）")
print("=" * 60)
out, err = ssh_exec("""cd /home/admin/Google-Data-Analysis/backend && python3 -c "
from app.database import SessionLocal
from app.models.site import PubSite
db = SessionLocal()
sites = db.query(PubSite).all()
for s in sites:
    print(f'id={s.id}, name={s.site_name}, path={s.site_path}, domain={s.domain}, migrated={s.migrated}')
db.close()
" """)
print(out or "(无数据)")
if err:
    print("ERR:", err)

print("\n" + "=" * 60)
print("3. 查看已发布的文章状态")
print("=" * 60)
out, err = ssh_exec("""cd /home/admin/Google-Data-Analysis/backend && python3 -c "
from app.database import SessionLocal
from app.models.article import PubArticle
db = SessionLocal()
articles = db.query(PubArticle).filter(PubArticle.deleted_at.is_(None)).order_by(PubArticle.id.desc()).limit(5).all()
for a in articles:
    print(f'id={a.id}, title={a.title[:50]}, status={a.status}, published_to_site={a.published_to_site}, site_id={a.site_id}, slug={a.slug}, site_article_slug={a.site_article_slug}')
db.close()
" """)
print(out or "(无数据)")
if err:
    print("ERR:", err)

print("\n" + "=" * 60)
print("4. 检查网站目录中的文件")
print("=" * 60)
out, err = ssh_exec("ls -la /home/admin/sites/ 2>/dev/null && echo '---' && find /home/admin/sites/ -name '*.html' -o -name '*.json' -o -name 'articles-index.js' 2>/dev/null | head -30")
print(out or "(目录不存在)")
if err:
    print("ERR:", err)

print("\n" + "=" * 60)
print("5. 检查 AuraBloom 实际网站目录")
print("=" * 60)
out, err = ssh_exec("find /home/admin/ -name 'articles-index.js' -type f 2>/dev/null | head -10")
print(out or "(未找到)")
if err:
    print("ERR:", err)

out2, err2 = ssh_exec("find /home/admin/ -name 'main.js' -path '*/js/*' -type f 2>/dev/null | head -10")
print(out2 or "(未找到 main.js)")

print("\n" + "=" * 60)
print("6. 检查 Nginx 站点配置")
print("=" * 60)
out, err = ssh_exec("grep -r 'aura\|bloom\|sites' /etc/nginx/sites-enabled/ 2>/dev/null || grep -r 'aura\|bloom\|sites' /etc/nginx/conf.d/ 2>/dev/null || echo 'not found'")
print(out or "(未找到)")
if err:
    print("ERR:", err)
