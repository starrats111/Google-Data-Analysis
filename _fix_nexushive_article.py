"""修复 nexushive.top 已发布文章的模板问题
在后端服务器（47.239.193.33）上运行：
  cd /home/admin/Google-Data-Analysis && source backend/venv/bin/activate
  python _fix_nexushive_article.py

修复内容：
  - 从 index.html 提取正确的 CSS/header/footer
  - 用内联样式重建文章 HTML，保证图片全宽显示
"""
import sys, os, re

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "backend"))
os.environ.setdefault("ENV", "production")

try:
    from app.services.remote_publisher import remote_publisher
    USE_PUBLISHER = True
    print("✓ 使用 remote_publisher 模块")
except Exception as e:
    USE_PUBLISHER = False
    print(f"⚠ remote_publisher 不可用 ({e})，使用独立模式")
    import paramiko


SITE_ROOT = "/www/wwwroot/nexushive.top"
ARTICLE_FILE = "post-top-5-revo-sunglasses-for-ultimate-clarity-and-style.html"


def fix_with_publisher():
    """使用已有的 remote_publisher 模块修复"""
    ssh = remote_publisher._connect()
    sftp = ssh.open_sftp()

    # 提取站点模板
    template = remote_publisher._extract_site_template(sftp, SITE_ROOT)
    print(f"✓ 提取模板: brand={template['brand_name']}")
    print(f"  head_links: {len(template['head_links'])} chars")
    print(f"  header: {len(template['header_html'])} chars")
    print(f"  footer: {len(template['footer_html'])} chars")

    # 读取现有文章
    article_path = f"{SITE_ROOT}/{ARTICLE_FILE}"
    article_html = remote_publisher._sftp_read(sftp, article_path)
    print(f"✓ 文章读取成功 ({len(article_html)} bytes)")

    # 提取文章元素
    art = extract_article_content(article_html)
    print(f"✓ title: {art['title']}")
    print(f"✓ kicker: {art['kicker']}")
    print(f"✓ hero: {art['hero_src'][:60]}...")
    print(f"✓ content: {len(art['content_html'])} chars")

    # 构建修复后的 HTML
    fixed = build_fixed_html(template, art)
    print(f"✓ 新 HTML: {len(fixed)} bytes")

    # 备份并写入
    remote_publisher._sftp_write(sftp, f"{article_path}.bak", article_html)
    print("✓ 已备份旧文件")

    remote_publisher._sftp_write(sftp, article_path, fixed)
    print("✓ 已写入修复后的文章")

    sftp.close()
    ssh.close()


def fix_standalone():
    """独立模式：直接 SSH 连接"""
    dotenv_path = os.path.join(os.path.dirname(__file__), "backend", ".env")
    bt_host = bt_user = bt_key = bt_pass = ""
    if os.path.exists(dotenv_path):
        with open(dotenv_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("BT_SSH_HOST="):
                    bt_host = line.split("=", 1)[1].strip().strip('"').strip("'")
                elif line.startswith("BT_SSH_USER="):
                    bt_user = line.split("=", 1)[1].strip().strip('"').strip("'")
                elif line.startswith("BT_SSH_KEY_PATH="):
                    bt_key = line.split("=", 1)[1].strip().strip('"').strip("'")
                elif line.startswith("BT_SSH_PASSWORD="):
                    bt_pass = line.split("=", 1)[1].strip().strip('"').strip("'")

    if not bt_host:
        bt_host = input("BT SSH Host [52.74.221.116]: ").strip() or "52.74.221.116"
    if not bt_user:
        bt_user = input("BT SSH User [ubuntu]: ").strip() or "ubuntu"

    print(f"连接 {bt_user}@{bt_host}...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kwargs = {"hostname": bt_host, "port": 22, "username": bt_user, "timeout": 15}
    if bt_key:
        kwargs["key_filename"] = bt_key
    elif bt_pass:
        kwargs["password"] = bt_pass
    else:
        kwargs["look_for_keys"] = True
    ssh.connect(**kwargs)
    sftp = ssh.open_sftp()

    # 读取 index.html
    with sftp.open(f"{SITE_ROOT}/index.html", "r") as f:
        index_html = f.read().decode("utf-8")
    template = extract_template_from_html(index_html)
    print(f"✓ 提取模板: brand={template['brand_name']}")

    # 读取文章
    article_path = f"{SITE_ROOT}/{ARTICLE_FILE}"
    with sftp.open(article_path, "r") as f:
        article_html = f.read().decode("utf-8")
    print(f"✓ 文章读取成功 ({len(article_html)} bytes)")

    art = extract_article_content(article_html)
    fixed = build_fixed_html(template, art)

    # 备份并写入
    with sftp.open(f"{article_path}.bak", "w") as f:
        f.write(article_html.encode("utf-8"))
    with sftp.open(article_path, "w") as f:
        f.write(fixed.encode("utf-8"))
    print("✓ 已写入修复后的文章")

    sftp.close()
    ssh.close()


def extract_template_from_html(index_html):
    """从 index.html 提取模板信息"""
    template = {
        "head_links": "",
        "header_html": "",
        "footer_html": "",
        "brand_name": "Editorial",
        "body_class": "",
        "scripts": "",
    }
    m = re.search(r'<title>([^<]+)</title>', index_html)
    if m:
        template["brand_name"] = m.group(1).split(" - ")[0].split(" | ")[0].strip()
    m = re.search(r'<body[^>]*class=["\']([^"\']*)["\']', index_html)
    if m:
        template["body_class"] = m.group(1)
    head_m = re.search(r'<head[^>]*>(.*?)</head>', index_html, re.DOTALL)
    if head_m:
        links = re.findall(r'<link[^>]+(?:stylesheet|preconnect|fonts)[^>]*>', head_m.group(1))
        template["head_links"] = "\n  ".join(links)
    m = re.search(r'(<header[^>]*>.*?</header>)', index_html, re.DOTALL)
    if m:
        template["header_html"] = m.group(1)
    m = re.search(r'(<footer[^>]*>.*?</footer>)', index_html, re.DOTALL)
    if m:
        template["footer_html"] = m.group(1)
    scripts = re.findall(r'<script[^>]+src=["\'][^"\']+["\'][^>]*></script>', index_html)
    template["scripts"] = "\n  ".join(scripts)
    return template


def extract_article_content(article_html):
    """从已发布的文章 HTML 中提取内容"""
    title_m = re.search(r'<h1[^>]*>(.*?)</h1>', article_html, re.DOTALL)
    title = title_m.group(1).strip() if title_m else "Article"

    kicker_m = re.search(r'class="ab-page-kicker"[^>]*>(.*?)</p>', article_html, re.DOTALL)
    kicker = kicker_m.group(1).strip() if kicker_m else ""

    subtitle_m = re.search(r'class="ab-page-subtitle"[^>]*>\s*(.*?)\s*</p>', article_html, re.DOTALL)
    excerpt = subtitle_m.group(1).strip() if subtitle_m else ""

    hero_m = re.search(r'class="ab-page-hero-img"[\s\S]*?<img\s+[^>]*src="([^"]*)"', article_html, re.DOTALL)
    hero_src = hero_m.group(1) if hero_m else ""

    cat_m = re.search(r'Category:\s*([^<]+)', article_html)
    category = cat_m.group(1).strip() if cat_m else "fashion"

    # 提取正文内容
    content_html = ""
    main_m = re.search(
        r'class="ab-page-meta-row".*?</div>\s*(.*?)\s*</div>\s*(?:<aside|$)',
        article_html, re.DOTALL
    )
    if main_m:
        content_html = main_m.group(1).strip()

    if not content_html:
        # fallback: 收集所有 h2/h3/p/div.article-content-image
        blocks = []
        for m in re.finditer(
            r'<(?:h2|h3|p|div class="article-content-image")[^>]*>[\s\S]*?</(?:h2|h3|p|div)>',
            article_html
        ):
            text = m.group(0)
            if any(kw in text for kw in ["Finding the Perfect", "<h2", "article-content-image"]):
                blocks.append(text)
        if blocks:
            content_html = "\n\n".join(blocks)

    read_m = re.search(r'(\d+)\s*min\s*read', kicker)
    read_time = int(read_m.group(1)) if read_m else 3

    date_label = "Mar 20, 2026"
    if "·" in kicker:
        parts = kicker.split("·")
        if len(parts) >= 2:
            date_label = parts[1].strip()

    return {
        "title": title,
        "kicker": kicker,
        "excerpt": excerpt,
        "hero_src": hero_src,
        "category": category,
        "content_html": content_html,
        "read_time": read_time,
        "date_label": date_label,
    }


def build_fixed_html(template, art):
    """构建修复后的 HTML"""
    brand = template.get("brand_name", "Editorial")
    head_links = template.get("head_links", "")
    header_html = template.get("header_html", "")
    footer_html = template.get("footer_html", "")
    body_class = template.get("body_class", "")
    scripts = template.get("scripts", "")

    body_attr = f' class="{body_class}"' if body_class else ""

    return f'''<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{art["title"]} &#8211; {brand}</title>
  {head_links}
</head>
<body{body_attr}>
  {header_html}

    <main>
      <article>
        <header style="padding:3rem 2rem 1.5rem;text-align:center;max-width:900px;margin:0 auto">
          <p style="font-size:0.85rem;text-transform:uppercase;letter-spacing:1.5px;color:#888;margin-bottom:1rem">{art["kicker"]}</p>
          <h1 style="font-size:2.5rem;line-height:1.2;margin-bottom:1rem">{art["title"]}</h1>
          <p style="font-size:1.15rem;color:#666;line-height:1.6">
            {art["excerpt"]}
          </p>
        </header>

        <div style="max-width:900px;margin:0 auto;padding:0 2rem 3rem">
          <div style="margin-bottom:2rem;border-radius:12px;overflow:hidden">
            <img
              src="{art["hero_src"]}"
              alt="{art["title"]}"
              loading="lazy"
              style="width:100%;height:auto;display:block"
            />
          </div>
          <div style="margin-bottom:2rem">
            <span style="display:inline-block;padding:0.35rem 0.75rem;background:#f0ebe3;border-radius:20px;font-size:0.8rem;color:#666">Category: {art["category"]}</span>
          </div>

          <div class="article-content" style="font-size:1.1rem;line-height:1.8;color:#444">
            {art["content_html"]}
          </div>

          <div style="margin-top:2.5rem;padding:1.5rem;background:#f9f6f1;border-radius:12px">
            <p style="font-size:0.85rem;color:#888">
              Category: {art["category"]} &middot;
              Reading time: approximately {art["read_time"]} minutes
            </p>
            <p style="font-size:0.85rem;color:#888;margin-top:0.5rem">
              Published on {art["date_label"]}.
              Discover more stories on <a href="index.html" style="color:#d4874b">{brand}</a>.
            </p>
          </div>
        </div>
      </article>
    </main>

  {footer_html}

  {scripts}
</body>
</html>'''


if __name__ == "__main__":
    print("=" * 60)
    print("修复 nexushive.top 文章模板")
    print("=" * 60)
    try:
        if USE_PUBLISHER:
            fix_with_publisher()
        else:
            fix_standalone()
        print(f"\n🔗 请验证: https://nexushive.top/{ARTICLE_FILE}")
        print("✅ 修复完成！")
    except Exception as e:
        print(f"\n❌ 修复失败: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
