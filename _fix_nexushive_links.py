"""修复 nexushive.top 文章追踪链接（v3）
1. 清理 <title> 中被错误插入的链接
2. 检查正文链接是否正确，如果已有则保留
3. 如果正文无链接则重新插入

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


print("=" * 60)
print("修复 nexushive.top 文章追踪链接 (v3)")
print("=" * 60)

ssh = remote_publisher._connect()
sftp = ssh.open_sftp()

article_path = f"{SITE_ROOT}/{ARTICLE_FILE}"
html = remote_publisher._sftp_read(sftp, article_path)
print(f"✓ 读取文章 ({len(html)} bytes)")

changed = False

# 1. 清理 <title> 中被错误插入的链接
title_m = re.search(r'<title>(.*?)</title>', html, re.DOTALL)
if title_m and '<a href' in title_m.group(1):
    old_title = title_m.group(1)
    clean_title = re.sub(r'<a[^>]*>(.*?)</a>', r'\1', old_title)
    clean_title = re.sub(r'<strong>(.*?)</strong>', r'\1', clean_title)
    html = html.replace(f'<title>{old_title}</title>', f'<title>{clean_title}</title>')
    changed = True
    print("✓ 已清理 <title> 中的错误链接")

# 2. 清理 <header> 区域中被错误插入的链接（kicker/h1/subtitle）
header_m = re.search(r'(<header\b[^>]*>)(.*?)(</header>)', html, re.DOTALL)
if header_m and TRACK_URL in header_m.group(2):
    header_body = header_m.group(2)
    clean_header = re.sub(r'<a href="' + re.escape(TRACK_URL) + r'"[^>]*>(.*?)</a>', r'\1', header_body)
    clean_header = re.sub(r'<strong>((?:Revo|polarized|sunglasses|fashion)[^<]*)</strong>',
                          r'\1', clean_header, flags=re.IGNORECASE)
    if clean_header != header_body:
        html = html.replace(header_m.group(0),
                            header_m.group(1) + clean_header + header_m.group(3))
        changed = True
        print("✓ 已清理 <header> 中的错误链接")

# 3. 清理 meta/category span 中被错误插入的链接
meta_spans = re.findall(r'<span[^>]*style="[^"]*background[^>]*>.*?</span>', html, re.DOTALL)
for span in meta_spans:
    if TRACK_URL in span:
        clean_span = re.sub(r'<a href="' + re.escape(TRACK_URL) + r'"[^>]*>(.*?)</a>', r'\1', span)
        clean_span = re.sub(r'<strong>(.*?)</strong>', r'\1', clean_span)
        html = html.replace(span, clean_span)
        changed = True
        print("✓ 已清理 category span 中的错误链接")

# 4. 清理 footer 中被错误插入的链接
footer_m = re.search(r'(<footer\b[^>]*>)(.*?)(</footer>)', html, re.DOTALL)
if footer_m and TRACK_URL in footer_m.group(2):
    footer_body = footer_m.group(2)
    clean_footer = re.sub(r'<a href="' + re.escape(TRACK_URL) + r'"[^>]*>(.*?)</a>', r'\1', footer_body)
    clean_footer = re.sub(r'<strong>((?:Revo|polarized|sunglasses|fashion)[^<]*)</strong>',
                          r'\1', clean_footer, flags=re.IGNORECASE)
    if clean_footer != footer_body:
        html = html.replace(footer_m.group(0),
                            footer_m.group(1) + clean_footer + footer_m.group(3))
        changed = True
        print("✓ 已清理 <footer> 中的错误链接")

# 5. 定位文章正文区域
content_m = re.search(
    r'(<div[^>]*class="article-content"[^>]*>)(.*?)(</div>\s*<div\s+style="margin-top)',
    html, re.DOTALL
)
if not content_m:
    content_m = re.search(
        r'(<div[^>]*class="article-content"[^>]*>)(.*?)(</div>\s*</div>\s*</article>)',
        html, re.DOTALL
    )

if not content_m:
    print("❌ 无法定位文章正文区域，打印 HTML 结构调试...")
    # 找到所有 div 的 class
    for m in re.finditer(r'<div[^>]*class="([^"]*)"', html):
        print(f"  div.{m.group(1)}")
    print("\n尝试在整个 <article> 内容中操作...")
    content_m = re.search(r'(<article[^>]*>)(.*?)(</article>)', html, re.DOTALL)

if not content_m:
    print("❌ 无法定位任何文章区域")
    sftp.close()
    ssh.close()
    sys.exit(1)

content_start = content_m.start(2)
content_end = content_m.end(2)
content_html = content_m.group(2)
print(f"✓ 定位到文章正文 ({len(content_html)} chars)")

# 统计正文中已有的追踪链接数
existing_body_links = content_html.count(TRACK_URL)
print(f"  正文已有追踪链接: {existing_body_links}")

# 如果正文已有 >= 8 个链接，只做清理不做插入
if existing_body_links >= 8:
    print(f"✓ 正文已有 {existing_body_links} 个追踪链接，无需再插入")
    # 打印链接上下文
    for m in re.finditer(r'<a[^>]*' + re.escape(TRACK_URL[:40]) + r'[^>]*>(.*?)</a>', content_html):
        anchor = re.sub(r'<[^>]+>', '', m.group(1)).strip()
        print(f"    链接锚文本: {anchor}")
else:
    # 需要在正文中插入链接
    print(f"  需要插入追踪链接...")

    # 先清理正文中可能存在的错误链接（如嵌套在错误位置的）
    content_html_clean = re.sub(
        r'<a href="' + re.escape(TRACK_URL) + r'"[^>]*>(.*?)</a>',
        lambda m: re.sub(r'<strong>(.*?)</strong>', r'\1', m.group(1)),
        content_html
    )
    if content_html_clean != content_html:
        print("  已清理正文中的旧链接，重新插入...")
        content_html = content_html_clean

    # 在 <p> 标签中插入链接
    keywords_left = list(LINK_TARGETS)

    def process_paragraph(match):
        nonlocal keywords_left
        p_open = match.group(1)
        p_body = match.group(2)
        p_close = match.group(3)

        inserted_here = 0
        for kw in list(keywords_left):
            if inserted_here >= 2:
                break
            if kw.lower() not in p_body.lower():
                continue
            # 确保不在已有的链接/标签内
            test = re.sub(r'<[^>]+>', '', p_body)
            if kw.lower() not in test.lower():
                continue
            pattern = re.compile(r'\b(' + re.escape(kw) + r')\b', re.IGNORECASE)
            new_body = pattern.sub(lambda m: make_link(m.group(1)), p_body, count=1)
            if new_body != p_body:
                p_body = new_body
                keywords_left.remove(kw)
                inserted_here += 1
                print(f"    ✓ 插入: {kw}")

        return p_open + p_body + p_close

    content_html = re.sub(r'(<p[^>]*>)(.*?)(</p>)', process_paragraph, content_html, flags=re.DOTALL)

    total_inserted = 10 - len(keywords_left)
    print(f"\n  共插入 {total_inserted} 个追踪链接")
    if keywords_left:
        print(f"  未匹配: {keywords_left}")

    # 替换正文内容
    html = html[:content_start] + content_html + html[content_end:]
    changed = True

# 6. 写入
if changed:
    # 最终验证
    final_title_m = re.search(r'<title>(.*?)</title>', html, re.DOTALL)
    title_has_link = '<a href' in final_title_m.group(1) if final_title_m else False

    final_body_m = re.search(r'class="article-content".*?</article>', html, re.DOTALL)
    body_link_count = final_body_m.group(0).count(TRACK_URL) if final_body_m else html.count(TRACK_URL)

    print(f"\n=== 最终状态 ===")
    print(f"  title 中有链接: {'❌ 是' if title_has_link else '✓ 否'}")
    print(f"  正文追踪链接数: {body_link_count}")

    remote_publisher._sftp_write(sftp, article_path, html)
    print("\n✓ 已写入更新后的文章")
else:
    print("\n无任何变更需要写入")

sftp.close()
ssh.close()

print(f"\n🔗 验证: https://nexushive.top/{ARTICLE_FILE}")
print("✅ 完成！")
