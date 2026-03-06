"""
网站发布服务（OPT-013）
本地文件系统读写，将文章发布到 Nginx 静态网站目录。
"""
import fcntl
import json
import logging
import re
import shutil
from pathlib import Path

from app.utils.slug import generate_slug

logger = logging.getLogger(__name__)

ALLOWED_BASE = "/home/admin/sites"


def validate_site_path(site_path: str) -> None:
    """校验 site_path 在允许范围内，防止路径遍历"""
    resolved = Path(site_path).resolve()
    if not str(resolved).startswith(ALLOWED_BASE):
        raise ValueError(f"site_path 必须在 {ALLOWED_BASE} 下")


def verify_site(site_path: str) -> dict:
    """验证网站目录结构是否合法，返回检查结果"""
    base = Path(site_path)
    checks = {
        "directory_exists": base.is_dir(),
        "index_html": (base / "index.html").is_file(),
        "articles_index_js": (base / "js" / "articles-index.js").is_file(),
        "main_js": (base / "js" / "main.js").is_file(),
    }
    checks["valid"] = all(checks.values())
    return checks


def parse_articles_index(content: str) -> list:
    """解析 articles-index.js 中的 articlesIndex 数组"""
    match = re.search(r'const articlesIndex\s*=\s*(\[[\s\S]*?\]);', content)
    if not match:
        raise ValueError("无法定位 articlesIndex 数组")
    return json.loads(match.group(1))


def serialize_articles_index(articles_list: list) -> str:
    """将 Python list 序列化回 articles-index.js 格式"""
    json_str = json.dumps(articles_list, indent=2, ensure_ascii=False)
    return (
        "// 文章索引 - 由系统自动更新\n"
        "// 列表页使用此文件，详情页按需加载 articles/*.json\n\n"
        f"const articlesIndex = {json_str};\n\n"
        "// 兼容旧代码\nconst articles = articlesIndex;\n"
    )


def publish_article(site, article) -> dict:
    """
    发布文章到网站：按安全顺序写入 HTML → JSON → articles-index.js
    site: PubSite 对象
    article: PubArticle 对象（需 eager load category）
    返回 {"site_article_slug": ..., "site_article_id": ...}
    """
    base = Path(site.site_path)
    slug = article.slug
    index_path = base / (site.data_js_path or "js/articles-index.js")

    with open(index_path, "r+", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            content = f.read()
            articles_list = parse_articles_index(content)

            if any(a.get("slug") == slug for a in articles_list):
                raise ValueError(f"slug '{slug}' 已存在于网站索引中")

            new_id = max((a.get("id", 0) for a in articles_list), default=0) + 1

            category_slug = "general"
            if article.category and hasattr(article.category, "slug"):
                category_slug = article.category.slug

            new_entry = {
                "id": new_id,
                "slug": slug,
                "title": article.title,
                "category": category_slug,
                "date": article.created_at.strftime("%Y-%m-%d") if article.created_at else "",
                "image": article.featured_image or "",
                "excerpt": article.excerpt or "",
                "content": article.content or "",
                "hasProducts": False,
            }

            template_path = base / (site.article_template or "article-1.html")
            html_path = base / f"article-{slug}.html"
            if template_path.exists():
                shutil.copy2(template_path, html_path)
            else:
                logger.warning(f"模板文件不存在: {template_path}，跳过 HTML 创建")

            json_dir = base / "js" / "articles"
            json_dir.mkdir(parents=True, exist_ok=True)
            json_path = json_dir / f"{slug}.json"
            json_path.write_text(
                json.dumps(new_entry, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )

            articles_list.append(new_entry)
            f.seek(0)
            f.write(serialize_articles_index(articles_list))
            f.truncate()

            logger.info(f"文章已发布到网站: slug={slug}, site={site.site_name}")
            return {"site_article_slug": slug, "site_article_id": new_id}
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def unpublish_article(site, slug: str) -> None:
    """
    从网站移除文章：按安全顺序更新 index → 删 JSON → 删 HTML
    """
    base = Path(site.site_path)
    index_path = base / (site.data_js_path or "js/articles-index.js")

    with open(index_path, "r+", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            content = f.read()
            articles_list = parse_articles_index(content)
            articles_list = [a for a in articles_list if a.get("slug") != slug]

            f.seek(0)
            f.write(serialize_articles_index(articles_list))
            f.truncate()
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)

    json_path = base / "js" / "articles" / f"{slug}.json"
    if json_path.exists():
        json_path.unlink()

    html_path = base / f"article-{slug}.html"
    if html_path.exists():
        html_path.unlink()

    logger.info(f"文章已从网站移除: slug={slug}, site={site.site_name}")


def migrate_to_slug(site) -> dict:
    """
    一次性迁移：为现有文章生成 slug + 重命名文件 + 更新 main.js
    返回 {"migrated_count": int, "errors": list}
    """
    base = Path(site.site_path)
    index_path = base / (site.data_js_path or "js/articles-index.js")
    errors = []

    content = index_path.read_text(encoding="utf-8")
    articles_list = parse_articles_index(content)

    for article in articles_list:
        if "slug" not in article or not article["slug"]:
            article["slug"] = generate_slug(article.get("title", f"article-{article.get('id', 0)}"))

    for article in articles_list:
        slug = article["slug"]
        aid = article.get("id", "")

        old_html = base / f"article-{aid}.html"
        new_html = base / f"article-{slug}.html"
        if old_html.exists() and not new_html.exists():
            try:
                old_html.rename(new_html)
            except Exception as e:
                errors.append(f"重命名 HTML {old_html.name} 失败: {e}")

        old_json = base / "js" / "articles" / f"{aid}.json"
        new_json = base / "js" / "articles" / f"{slug}.json"
        if old_json.exists() and not new_json.exists():
            try:
                old_json.rename(new_json)
                data = json.loads(new_json.read_text(encoding="utf-8"))
                data["slug"] = slug
                new_json.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
            except Exception as e:
                errors.append(f"重命名 JSON {old_json.name} 失败: {e}")

    index_path.write_text(serialize_articles_index(articles_list), encoding="utf-8")

    main_js_path = base / "js" / "main.js"
    if main_js_path.exists():
        try:
            mc = main_js_path.read_text(encoding="utf-8")
            mc = mc.replace(
                "article-${article.id}.html",
                "article-${article.slug}.html",
            )
            mc = mc.replace(
                "const articleId = parseInt(currentPage.replace('article-', '').replace('.html', ''));",
                "const articleSlug = currentPage.replace('article-', '').replace('.html', '');",
            )
            mc = mc.replace(
                "const article = articles.find(a => a.id === articleId);",
                "const article = articles.find(a => a.slug === articleSlug);",
            )
            main_js_path.write_text(mc, encoding="utf-8")
        except Exception as e:
            errors.append(f"更新 main.js 失败: {e}")

    logger.info(f"Slug 迁移完成: {len(articles_list)} 篇文章, {len(errors)} 个错误")
    return {"migrated_count": len(articles_list), "errors": errors}
