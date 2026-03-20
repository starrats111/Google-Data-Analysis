"""修复 nexushive.top 文章中丢失的追踪链接（v2）
只在 article-content div 内的 <p> 段落中插入链接，不影响 title/header/footer。

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
    "polarized sunglasses",
    "Revo Sunglasses",
    "Revo Explorer",
    "Surf model",
    "Alpine goggles",
    "luxury sunglasses",
    "2 year warranty",
    "fashion sunglasses",
    "worth the investment",
    "outdoor activity",
]


def make_link(text):
    return f'<a href="{TRACK_URL}" target="_blank" rel="noopener"><strong>{text}</strong></a>'


def insert_links_in_paragraph(p_html, keywords_remaining):
    """在单个 <p> 标签的内容中插入追踪链接，每段最多插入 2 个"""
    inserted_in_p = 0
    for kw in list(keywords_remaining):
        if inserted_in_p >= 2:
            break
        if kw.lower() in p_html.lower():
            # 检查这个关键词是否已经在链接内
            if f'>{kw}<' in p_html or f'>{kw}</strong>' in p_html:
                continue
            # 大小写不敏感替换，只替换第一个
            pattern = re.compile(r'(?<!["\'>])(' + re.escape(kw) + r')(?!["\'])', re.IGNORECASE)
            new_html = pattern.sub(make_link(kw), p_html, count=1)
            if new_html != p_html:
                p_html = new_html
                keywords_remaining.remove(kw)
                inserted_in_p += 1
    return p_html, keywords_remaining


print("=" * 60)
print("修复 nexushive.top 文章追踪链接 (v2)")
print("=" * 60)

ssh = remote_publisher._connect()
sftp = ssh.open_sftp()

article_path = f"{SITE_ROOT}/{ARTICLE_FILE}"
html = remote_publisher._sftp_read(sftp, article_path)
print(f"✓ 读取文章 ({len(html)} bytes)")

# 先清理掉之前可能错误插入到 <title> 中的链接
title_m = re.search(r'<title>(.*?)</title>', html, re.DOTALL)
if title_m and '<a href' in title_m.group(1):
    old_title = title_m.group(1)
    clean_title = re.sub(r'<a[^>]*>(.*?)</a>', r'\1', old_title)
    clean_title = re.sub(r'<strong>(.*?)</strong>', r'\1', clean_title)
    html = html.replace(f'<title>{old_title}</title>', f'<title>{clean_title}</title>')
    print("✓ 已清理 <title> 中的错误链接")

# 定位文章正文区域：找 article-content div
content_m = re.search(
    r'(<div[^>]*class="article-content"[^>]*>)(.*?)(</div>\s*<div\s+style="margin-top)',
    html, re.DOTALL
)
if not content_m:
    # fallback: 找更宽泛的文章内容区域
    content_m = re.search(
        r'(<div[^>]*class="article-content"[^>]*>)(.*?)(</div>\s*</div>\s*</article>)',
        html, re.DOTALL
    )

if not content_m:
    print("❌ 无法定位文章正文区域")
    sftp.close()
    ssh.close()
    sys.exit(1)

prefix = html[:content_m.start(2)]
content_html = content_m.group(2)
suffix = html[content_m.end(2):]
print(f"✓ 定位到文章正文 ({len(content_html)} chars)")

# 在正文 <p> 段落中逐个插入链接
keywords_left = list(LINK_TARGETS)
total_inserted = 0

# 找所有 <p>...</p> 块
p_pattern = re.compile(r'(<p[^>]*>)(.*?)(</p>)', re.DOTALL)
parts = []
last_end = 0

for m in p_pattern.finditer(content_html):
    parts.append(content_html[last_end:m.start()])
    p_open = m.group(1)
    p_body = m.group(2)
    p_close = m.group(3)

    if keywords_left:
        old_body = p_body
        p_body, keywords_left = insert_links_in_paragraph(p_body, keywords_left)
        if p_body != old_body:
            total_inserted += (len(old_body.split('<a href')) - len(p_body.split('<a href'))) * -1
            # 简单计数
            new_links = p_body.count(TRACK_URL) - old_body.count(TRACK_URL)
            if new_links > 0:
                pass  # already counted by keywords_left

    parts.append(p_open + p_body + p_close)
    last_end = m.end()

parts.append(content_html[last_end:])
new_content = "".join(parts)

total_inserted = 10 - len(keywords_left)
print(f"\n共插入 {total_inserted} 个追踪链接")
if keywords_left:
    print(f"  未找到的关键词: {keywords_left}")

new_html = prefix + new_content + suffix

# 验证
final_count = new_html.count(TRACK_URL)
title_count = 0
title_m2 = re.search(r'<title>(.*?)</title>', new_html, re.DOTALL)
if title_m2 and TRACK_URL in title_m2.group(1):
    title_count = 1
body_count = final_count - title_count
print(f"  正文追踪链接数: {body_count}")
print(f"  title 中链接数: {title_count} (应为 0)")

if total_inserted > 0:
    remote_publisher._sftp_write(sftp, article_path, new_html)
    print("✓ 已写入更新后的文章")
else:
    print("⚠ 未插入任何链接，不写入")

sftp.close()
ssh.close()

print(f"\n🔗 验证: https://nexushive.top/{ARTICLE_FILE}")
print("✅ 完成！")
