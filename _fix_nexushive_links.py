"""修复 nexushive.top 文章中丢失的追踪链接
在后端服务器上运行：
  cd /home/admin/Google-Data-Analysis && source backend/venv/bin/activate
  python _fix_nexushive_links.py
"""
import sys, os, re

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "backend"))
os.environ.setdefault("ENV", "production")

from app.services.remote_publisher import remote_publisher

SITE_ROOT = "/www/wwwroot/nexushive.top"
ARTICLE_FILE = "post-top-5-revo-sunglasses-for-ultimate-clarity-and-style.html"
TRACK_URL = (
    "https://www.linkhaitao.com/index.php?mod=lhdeal"
    "&track=4f593gi6QvDgf9s14QYWN93RfR2Y0UYpo5w4z95NpNRPAdtPrVtqNTSc56_aJ6qit"
    "&new=https%3A%2F%2Fwww.revo.com"
)

LINK_TARGETS = [
    ("polarized sunglasses", "polarized sunglasses"),
    ("Revo Sunglasses", "Revo Sunglasses"),
    ("Revo Explorer", "Revo Explorer"),
    ("Surf model", "Surf model"),
    ("Alpine goggles", "Alpine goggles"),
    ("luxury sunglasses", "luxury sunglasses"),
    ("2 year warranty", "2 year warranty"),
    ("fashion sunglasses", "fashion sunglasses"),
    ("worth the investment", "worth the investment"),
    ("outdoor activity", "outdoor activity"),
]


def make_link(anchor_text):
    return f'<a href="{TRACK_URL}" target="_blank" rel="noopener">{anchor_text}</a>'


print("=" * 60)
print("修复 nexushive.top 文章追踪链接")
print("=" * 60)

ssh = remote_publisher._connect()
sftp = ssh.open_sftp()

article_path = f"{SITE_ROOT}/{ARTICLE_FILE}"
html = remote_publisher._sftp_read(sftp, article_path)
print(f"✓ 读取文章 ({len(html)} bytes)")

existing_links = len(re.findall(r'href="https?://www\.linkhaitao\.com', html))
print(f"  当前追踪链接数: {existing_links}")

if existing_links >= 10:
    print("✓ 已有足够的追踪链接，无需修复")
    sftp.close()
    ssh.close()
    sys.exit(0)

inserted = 0
for keyword, anchor in LINK_TARGETS:
    if inserted >= 10:
        break
    link_html = make_link(anchor)
    if keyword in html and link_html not in html:
        # 只替换第一次出现，且确保不在已有链接内
        pattern = re.compile(
            r'(?<!>)(?<!href=")(?<!/)\b(' + re.escape(keyword) + r')\b(?!</a>)',
            re.IGNORECASE
        )
        new_html, count = pattern.subn(link_html, html, count=1)
        if count > 0:
            html = new_html
            inserted += 1
            print(f"  ✓ 插入链接: {keyword}")

print(f"\n共插入 {inserted} 个追踪链接")

if inserted > 0:
    remote_publisher._sftp_write(sftp, article_path, html)
    print("✓ 已写入更新后的文章")
else:
    print("⚠ 未插入任何链接")

sftp.close()
ssh.close()

print(f"\n🔗 验证: https://nexushive.top/{ARTICLE_FILE}")
print("✅ 完成！")
