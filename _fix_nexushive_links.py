"""修复 nexushive.top 文章追踪链接样式（v4）
给已有的追踪链接添加可见的内联样式（颜色、下划线），
使读者能看出这是可点击的链接。

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

LINK_STYLE = "color:#D4874B;font-weight:700;text-decoration:underline;text-underline-offset:2px"

print("=" * 60)
print("修复 nexushive.top 追踪链接样式 (v4)")
print("=" * 60)

ssh = remote_publisher._connect()
sftp = ssh.open_sftp()

article_path = f"{SITE_ROOT}/{ARTICLE_FILE}"
html = remote_publisher._sftp_read(sftp, article_path)
print(f"✓ 读取文章 ({len(html)} bytes)")

track_escaped = re.escape(TRACK_URL)
changed = False

# 找到所有追踪链接并添加样式
pattern = re.compile(
    r'<a\s+href="' + track_escaped + r'"([^>]*)>(.*?)</a>',
    re.DOTALL
)

matches = list(pattern.finditer(html))
print(f"  找到 {len(matches)} 个追踪链接")

for m in matches:
    attrs = m.group(1)
    inner = m.group(2)
    anchor_text = re.sub(r'<[^>]+>', '', inner).strip()
    print(f"    锚文本: {anchor_text}")

# 替换：给每个追踪链接加上 style 属性
def add_style(match):
    attrs = match.group(1)
    inner = match.group(2)

    # 去掉已有的 style 属性（如果有）
    attrs = re.sub(r'\s*style="[^"]*"', '', attrs)
    # 添加新 style
    new_attrs = f' style="{LINK_STYLE}"{attrs}'

    return f'<a href="{TRACK_URL}"{new_attrs}>{inner}</a>'

new_html, count = pattern.subn(add_style, html)

if count > 0:
    changed = True
    print(f"\n✓ 已给 {count} 个链接添加样式")
    print(f"  颜色: #D4874B (暖橙色)")
    print(f"  效果: 加粗 + 下划线")

if changed:
    remote_publisher._sftp_write(sftp, article_path, new_html)
    print("\n✓ 已写入更新后的文章")
else:
    print("\n⚠ 无变更")

sftp.close()
ssh.close()

print(f"\n🔗 验证: https://nexushive.top/{ARTICLE_FILE}")
print("✅ 完成！")
