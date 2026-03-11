"""
商家网站爬取服务（OPT-012）
httpx + BeautifulSoup 爬取商家首页 + 子页面
"""
import logging
import re
import ipaddress
import socket
from typing import List, Dict, Optional
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

SUB_PAGE_KEYWORDS = [
    "product", "shop", "store", "sale", "deal", "offer",
    "collection", "category", "about", "promotion", "new-arrival",
    "course", "program", "service", "bundle", "package", "pricing",
    "plan", "feature", "solution", "training", "class",
    "menu", "gallery", "portfolio", "work", "project",
    "catalog", "brand", "our-", "best", "popular", "top",
    "blog", "article", "review", "testimonial", "story",
    "ingredient", "formula", "organic", "natural", "health",
    "baby", "kids", "women", "men", "skin", "hair", "beauty",
    "supplement", "vitamin", "nutrition", "wellness", "fitness",
]

FILTERED_IMG_KEYWORDS = [
    "icon", "logo", "svg+xml", "pixel", "spacer", "blank", "1x1",
    "avatar", "favicon", "sprite", "arrow", "btn-", "button-icon",
    "social-icon", "facebook-icon", "twitter-icon", "instagram-icon",
    "linkedin-icon", "youtube-icon", "pinterest-icon", "tiktok-icon",
    "payment-icon", "visa-icon", "mastercard-icon", "paypal-icon",
    "flag-icon", "star-rating", "review-star",
    "wsj", "nytimes", "forbes-logo", "cnn-logo", "bbc-logo",
    "featured-in", "as-seen", "seen-on",
    # 第三方 stock 图片平台（不是商家自己的图片）
    "shutterstock.com", "istockphoto.com", "gettyimages.com",
    "dreamstime.com", "stock-photo", "stock_photo",
    # 广告和追踪像素
    "ad-banner", "advertisement", "tracking-pixel", "analytics",
    "doubleclick", "googlesyndication", "facebook.com/tr",
]

PRESS_SECTION_KEYWORDS = [
    "press-logo", "media-logo", "as-seen", "seen-on", "seen-in",
    "trusted-by-logo", "partner-logo", "endorsement",
    "publication-logo", "as_seen", "asSeen", "in-the-news",
    "press-section", "media-section", "press-bar", "trust-badge",
    "certification", "award-logo", "badge-logo",
]

# 产品图优先关键词
PRODUCT_IMG_KEYWORDS = [
    "product", "item", "meal", "food", "dish", "menu",
    "hero", "banner", "feature", "main", "gallery",
    "collection", "shop", "catalog", "lifestyle",
    "photo", "image", "pic", "img-large", "img-full",
]

MIN_IMG_DIMENSION = 200  # 最小宽高像素

# 内联 JS/JSON 中常见的图片 URL 模式
_JS_IMG_RE = re.compile(
    r'(?:src|image|img|photo|poster|thumbnail|hero|banner|background|cover|media)'
    r'["\s]*[:=]\s*["\']'
    r'(https?://[^"\'<>\s]{20,}\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"\'<>\s]*)?)',
    re.IGNORECASE,
)


def _extract_jsonld_images(ld_data, base_url: str, seen_urls: set, candidates: list):
    """递归提取 JSON-LD 结构化数据中的图片 URL"""
    if isinstance(ld_data, dict):
        for key in ("image", "images", "photo", "thumbnail", "logo", "contentUrl"):
            val = ld_data.get(key)
            if isinstance(val, str) and val.startswith(("http", "/")):
                full = urljoin(base_url, val)
                if full not in seen_urls and not any(kw in full.lower() for kw in FILTERED_IMG_KEYWORDS):
                    seen_urls.add(full)
                    candidates.append((25, full))
            elif isinstance(val, list):
                for item in val:
                    if isinstance(item, str) and item.startswith(("http", "/")):
                        full = urljoin(base_url, item)
                        if full not in seen_urls and not any(kw in full.lower() for kw in FILTERED_IMG_KEYWORDS):
                            seen_urls.add(full)
                            candidates.append((25, full))
                    elif isinstance(item, dict):
                        _extract_jsonld_images(item, base_url, seen_urls, candidates)
            elif isinstance(val, dict):
                url_in = val.get("url") or val.get("contentUrl") or val.get("src")
                if isinstance(url_in, str) and url_in.startswith(("http", "/")):
                    full = urljoin(base_url, url_in)
                    if full not in seen_urls:
                        seen_urls.add(full)
                        candidates.append((25, full))
        if "@graph" in ld_data:
            _extract_jsonld_images(ld_data["@graph"], base_url, seen_urls, candidates)
    elif isinstance(ld_data, list):
        for item in ld_data:
            _extract_jsonld_images(item, base_url, seen_urls, candidates)


HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Cache-Control": "no-cache",
    "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}

PRIVATE_NETS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),
]


def _validate_url(url: str) -> str:
    """SSRF 防护：校验 URL 安全性（L-25 闭环）"""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("仅支持 http/https 协议")
    hostname = parsed.hostname
    if not hostname:
        raise ValueError("无效的 URL")
    if hostname.lower() in ("localhost", "127.0.0.1", "0.0.0.0"):
        raise ValueError("不允许的 URL 地址")
    try:
        ip_str = socket.gethostbyname(hostname)
        ip = ipaddress.ip_address(ip_str)
        for net in PRIVATE_NETS:
            if ip in net:
                raise ValueError("不允许的 URL 地址")
    except socket.gaierror:
        pass
    return url


def _extract_page(html: str, url: str) -> Dict:
    """从 HTML 中提取结构化数据"""
    soup = BeautifulSoup(html, "lxml")

    title = ""
    if soup.title and soup.title.string:
        title = soup.title.string.strip()

    meta_desc = ""
    meta_tag = soup.find("meta", attrs={"name": "description"})
    if meta_tag and meta_tag.get("content"):
        meta_desc = meta_tag["content"].strip()

    og_name = ""
    og_tag = soup.find("meta", attrs={"property": "og:site_name"})
    if og_tag and og_tag.get("content"):
        og_name = og_tag["content"].strip()

    main_text = ""
    for container in [soup.find("main"), soup.find("article"),
                      soup.find("div", class_="content"),
                      soup.find("div", id="content")]:
        if container:
            main_text = container.get_text(separator="\n", strip=True)
            break
    if not main_text:
        body = soup.find("body")
        if body:
            for tag in body.find_all(["script", "style", "nav", "footer", "header"]):
                tag.decompose()
            main_text = body.get_text(separator="\n", strip=True)
    main_text = main_text[:3000]

    images = []
    og_img = soup.find("meta", attrs={"property": "og:image"})
    if og_img and og_img.get("content"):
        og_url = urljoin(url, og_img["content"])
        og_lower = og_url.lower()
        if not any(kw in og_lower for kw in FILTERED_IMG_KEYWORDS):
            images.append(og_url)

    # twitter:image 也是高质量图片来源
    tw_img = soup.find("meta", attrs={"name": "twitter:image"})
    if not tw_img:
        tw_img = soup.find("meta", attrs={"property": "twitter:image"})
    if tw_img and tw_img.get("content"):
        tw_url = urljoin(url, tw_img["content"])
        if tw_url not in images and not any(kw in tw_url.lower() for kw in FILTERED_IMG_KEYWORDS):
            images.append(tw_url)

    candidates = []
    seen_urls = set(images)

    # JSON-LD 结构化数据中的图片（高质量产品图）
    import json as _json
    for script_tag in soup.find_all("script", type="application/ld+json"):
        try:
            ld_data = _json.loads(script_tag.string or "")
            _extract_jsonld_images(ld_data, url, seen_urls, candidates)
        except Exception:
            pass

    def _get_img_src(tag):
        """从 img/source 标签中提取最佳图片 URL（支持懒加载和 srcset）"""
        lazy_attrs = (
            "src", "data-src", "data-lazy-src", "data-original",
            "data-srcset", "data-lazy", "data-image", "data-bg",
            "data-hi-res-src", "data-full-src", "data-zoom-image",
            "data-bg-src", "data-background-image", "data-thumb",
            "data-poster", "data-retina", "data-large-file",
            "data-medium-file", "data-unveil", "data-ll-src",
        )
        for attr in lazy_attrs:
            val = tag.get(attr)
            if val and val.startswith(("http", "/")):
                return val
        srcset = tag.get("srcset")
        if srcset:
            parts = [p.strip().split()[0] for p in srcset.split(",") if p.strip()]
            if parts:
                return parts[-1]
        return None

    # 收集所有 <img> 和 <picture><source> 的图片
    all_img_tags = soup.find_all("img")[:80]
    for source in soup.find_all("source"):
        if source.get("srcset") or source.get("data-srcset"):
            all_img_tags.append(source)

    # <noscript> 中的图片（lazy-load 的 fallback，通常是高质量图）
    for noscript in soup.find_all("noscript"):
        noscript_soup = BeautifulSoup(str(noscript), "lxml")
        for nimg in noscript_soup.find_all("img"):
            if nimg not in all_img_tags:
                all_img_tags.append(nimg)

    # 提取 CSS background-image 中的图片 URL
    bg_re = re.compile(r'url\(["\']?(https?://[^"\')\s]+)["\']?\)', re.IGNORECASE)
    for el in soup.find_all(style=True)[:60]:
        style_val = el.get("style", "")
        for match in bg_re.findall(style_val):
            match_lower = match.lower()
            if any(kw in match_lower for kw in FILTERED_IMG_KEYWORDS):
                continue
            if match not in seen_urls:
                seen_urls.add(match)
                candidates.append((8, match))

    # 内联 <style> 和 <link> 中的 background-image
    for style_tag in soup.find_all("style"):
        if style_tag.string:
            for match in bg_re.findall(style_tag.string):
                if match not in seen_urls and not any(kw in match.lower() for kw in FILTERED_IMG_KEYWORDS):
                    seen_urls.add(match)
                    candidates.append((5, match))

    # 从 <script> 标签中提取嵌入的图片 URL（SPA/现代网站常见）
    for script_tag in soup.find_all("script"):
        if script_tag.get("type") == "application/ld+json":
            continue
        script_text = script_tag.string or ""
        if len(script_text) < 50 or len(script_text) > 500000:
            continue
        for match in _JS_IMG_RE.findall(script_text):
            if match not in seen_urls and not any(kw in match.lower() for kw in FILTERED_IMG_KEYWORDS):
                full = urljoin(url, match)
                seen_urls.add(full)
                candidates.append((12, full))

    for img in all_img_tags:
        src = _get_img_src(img)
        if not src:
            continue
        src_lower = src.lower()
        alt = (img.get("alt") or "").lower()
        combined = src_lower + " " + alt
        if any(kw in combined for kw in FILTERED_IMG_KEYWORDS):
            continue
        full_url = urljoin(url, src)
        if full_url in seen_urls:
            continue
        seen_urls.add(full_url)

        score = 0
        is_in_press_section = False

        # --- 父容器检测：press/media/logo 区域直接跳过 ---
        ancestor = img.parent
        for _ in range(8):
            if ancestor is None:
                break
            anc_class = " ".join(ancestor.get("class", [])).lower() if hasattr(ancestor, "get") else ""
            anc_id = (ancestor.get("id") or "").lower() if hasattr(ancestor, "get") else ""
            anc_ctx = anc_class + " " + anc_id
            if any(kw in anc_ctx for kw in PRESS_SECTION_KEYWORDS):
                is_in_press_section = True
                break
            # 检测 testimonial/review/social-proof 区域（通常包含不相关的人物照片）
            if any(kw in anc_ctx for kw in [
                "testimonial", "review", "social-proof", "trust",
                "customer-review", "feedback", "quote", "endorsement",
                "instagram-feed", "social-feed", "ugc", "user-content",
            ]):
                is_in_press_section = True
                break
            ancestor = ancestor.parent

        if is_in_press_section:
            continue

        # --- 同域名图片加分（来自商家自己网站的图片更可能相关）---
        img_parsed = urlparse(full_url)
        url_parsed = urlparse(url)
        if img_parsed.hostname and url_parsed.hostname:
            # 同域名或同根域名
            img_root = ".".join((img_parsed.hostname or "").split(".")[-2:])
            url_root = ".".join((url_parsed.hostname or "").split(".")[-2:])
            if img_root == url_root:
                score += 15
            else:
                # 第三方域名图片扣分（除非是常见 CDN）
                cdn_hosts = ["cdn.shopify", "cloudinary", "imgix", "cloudfront",
                             "akamai", "fastly", "squarespace", "wixstatic",
                             "bigcommerce", "volusion"]
                is_cdn = any(h in (img_parsed.hostname or "").lower() for h in cdn_hosts)
                if not is_cdn:
                    score -= 10

        # --- 尺寸评分 ---
        w = img.get("width", "")
        h = img.get("height", "")
        try:
            w_val = int(str(w).replace("px", ""))
            h_val = int(str(h).replace("px", ""))
            if w_val >= 400 and h_val >= 300:
                score += 30
            elif w_val >= MIN_IMG_DIMENSION and h_val >= MIN_IMG_DIMENSION:
                score += 15
            elif w_val < 100 or h_val < 100:
                continue
        except (ValueError, TypeError):
            score += 3

        # --- 产品图关键词加分 ---
        if any(kw in src_lower or kw in alt for kw in PRODUCT_IMG_KEYWORDS):
            score += 20

        # --- srcset 大图加分 ---
        if img.get("srcset"):
            score += 10

        # --- 主内容区域加分 ---
        parent = img.parent
        for _ in range(5):
            if parent is None:
                break
            tag_name = getattr(parent, "name", "")
            if tag_name in ("main", "article", "section"):
                score += 15
                break
            parent_class = " ".join(parent.get("class", []))
            if any(kw in parent_class.lower() for kw in [
                "product", "hero", "gallery", "content", "menu", "meal",
                "recipe", "dish", "item", "card", "grid", "collection",
                "shop", "catalog", "feature", "banner", "slider",
            ]):
                score += 15
                break
            parent = parent.parent

        # --- nav/footer/header 扣分 ---
        parent = img.parent
        for _ in range(5):
            if parent is None:
                break
            if getattr(parent, "name", "") in ("nav", "footer", "header"):
                score -= 30
                break
            parent = parent.parent

        candidates.append((score, full_url))

    candidates.sort(key=lambda x: x[0], reverse=True)
    for _, img_url in candidates:
        if img_url not in images:
            images.append(img_url)
        if len(images) >= 50:
            break

    images = _deduplicate_cdn_images(images)
    images = _upgrade_cdn_thumbnails(images)

    return {
        "url": url,
        "title": title,
        "meta_description": meta_desc,
        "og_site_name": og_name,
        "text": main_text,
        "images": images,
    }


def _deduplicate_cdn_images(images: List[str]) -> List[str]:
    """
    CDN 去重：同一张图的不同尺寸/格式变体只保留一张。
    例如 nasm.org 的 ?width=2000&format=webply 和 ?width=750&format=jpg 是同一张图。
    优先保留 JPG > PNG > WebP，优先保留最大尺寸。
    """
    from urllib.parse import urlparse, parse_qs

    FORMAT_PRIORITY = {"jpg": 0, "jpeg": 0, "pjpg": 0, "png": 1, "webp": 2, "webply": 2}

    base_map = {}  # base_path -> (priority_score, url)
    result = []

    for img_url in images:
        parsed = urlparse(img_url)
        qs = parse_qs(parsed.query)
        has_cdn_params = any(k in qs for k in ("width", "format", "w", "h", "quality", "optimize", "fit", "crop"))

        if not has_cdn_params:
            result.append(img_url)
            continue

        base_path = parsed.scheme + "://" + parsed.netloc + parsed.path

        fmt = qs.get("format", [""])[0].lower()
        width = 0
        try:
            width = int(qs.get("width", qs.get("w", ["0"]))[0])
        except (ValueError, IndexError):
            pass
        fmt_score = FORMAT_PRIORITY.get(fmt, 1)
        priority = (fmt_score, -width)

        if base_path not in base_map or priority < base_map[base_path][0]:
            base_map[base_path] = (priority, img_url)

    for _, img_url in base_map.values():
        result.append(img_url)

    return result


def _upgrade_cdn_thumbnails(images: List[str]) -> List[str]:
    """
    将 CDN 缩略图 URL 升级为更大尺寸。
    例如 Shopify 的 ?width=100 → ?width=800
    """
    import re
    upgraded = []
    for img_url in images:
        url_lower = img_url.lower()
        # Shopify CDN: 替换 width=100 为 width=800
        if "cdn.shopify" in url_lower or "/cdn/shop/" in url_lower:
            # 替换 width 参数
            new_url = re.sub(r'[?&]width=\d+', '', img_url)
            # 替换 Shopify 尺寸后缀 (如 _450x450)
            new_url = re.sub(r'_\d+x\d+\.', '.', new_url)
            # 清理多余的 ? 或 &
            new_url = new_url.rstrip('?&')
            if new_url != img_url:
                upgraded.append(new_url)
            else:
                upgraded.append(img_url)
        else:
            upgraded.append(img_url)
    # 去重（升级后可能产生重复）
    seen = set()
    result = []
    for url in upgraded:
        if url not in seen:
            seen.add(url)
            result.append(url)
    return result


def _find_sub_pages(soup: BeautifulSoup, base_url: str) -> List[str]:
    """从首页链接中发现关键子页面 — 深度搜索策略"""
    parsed_base = urlparse(base_url)
    priority_pages = []   # 关键词匹配的高优先级页面
    other_pages = []      # 其他同域名内部页面
    seen = set()

    # 排除的路径模式（登录、隐私政策等无用页面）
    SKIP_PATTERNS = [
        "login", "signin", "signup", "register", "account", "cart", "checkout",
        "privacy", "terms", "policy", "cookie", "legal", "disclaimer",
        "sitemap", "feed", "rss", "xml", "json", "api/", "admin",
        "cdn-cgi", ".pdf", ".zip", ".mp4", ".mp3",
        "unsubscribe", "password", "reset", "confirm",
    ]

    for a in soup.find_all("a", href=True):
        href = a["href"]
        full = urljoin(base_url, href)
        parsed = urlparse(full)
        if parsed.netloc != parsed_base.netloc:
            continue
        path_lower = parsed.path.lower().rstrip("/")
        if not path_lower or path_lower == "/" or path_lower == parsed_base.path.rstrip("/"):
            continue
        if path_lower in seen:
            continue
        # 跳过无用页面
        if any(skip in path_lower for skip in SKIP_PATTERNS):
            continue
        # 跳过锚点链接和查询参数变体
        if "#" in href and not parsed.path:
            continue
        seen.add(path_lower)

        if any(kw in path_lower for kw in SUB_PAGE_KEYWORDS):
            priority_pages.append(full)
        else:
            other_pages.append(full)

    # 优先返回关键词匹配的页面，再补充其他内部页面
    result = priority_pages[:12] + other_pages[:8]
    return result[:15]


_FALLBACK_UAS = [
    # Chrome on Windows
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/123.0.0.0 Safari/537.36"
    ),
    # Chrome on Mac
    (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    ),
    # Firefox on Windows
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) "
        "Gecko/20100101 Firefox/126.0"
    ),
    # Firefox on Mac
    (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) "
        "Gecko/20100101 Firefox/126.0"
    ),
    # Safari on Mac
    (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) "
        "Version/17.5 Safari/605.1.15"
    ),
    # Edge on Windows
    (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0"
    ),
    # Chrome on Linux
    (
        "Mozilla/5.0 (X11; Linux x86_64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    # Chrome on Android (mobile)
    (
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Mobile Safari/537.36"
    ),
    # Safari on iPhone
    (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) "
        "Version/17.5 Mobile/15E148 Safari/604.1"
    ),
]

# 模拟真实浏览器 Cookie（GA 等常见 cookie）
import random as _random
import time as _time
import string as _string

def _generate_ga_cookies():
    """生成模拟的 Google Analytics cookie"""
    ga_id = f"GA1.2.{_random.randint(100000000, 999999999)}.{int(_time.time()) - _random.randint(0, 86400 * 30)}"
    gid = f"GA1.2.{_random.randint(100000000, 999999999)}.{int(_time.time())}"
    return f"_ga={ga_id}; _gid={gid}"

def _build_stealth_headers(url: str, ua: str = None) -> Dict:
    """构建模拟真实浏览器的请求头"""
    if ua is None:
        ua = _random.choice(_FALLBACK_UAS)

    parsed = urlparse(url)
    is_firefox = "Firefox" in ua
    is_safari = "Safari" in ua and "Chrome" not in ua

    headers = {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
        "Accept-Encoding": "gzip, deflate",
        "Cache-Control": "no-cache",
        "Upgrade-Insecure-Requests": "1",
        "Referer": "https://www.google.com/",
        "DNT": "1",
        "Connection": "keep-alive",
    }

    if not is_firefox and not is_safari:
        # Chrome/Edge specific headers
        chrome_ver = "125"
        import re as _re_local
        m = _re_local.search(r'Chrome/(\d+)', ua)
        if m:
            chrome_ver = m.group(1)
        headers.update({
            "Sec-Ch-Ua": f'"Chromium";v="{chrome_ver}", "Google Chrome";v="{chrome_ver}", "Not-A.Brand";v="99"',
            "Sec-Ch-Ua-Mobile": "?0",
            "Sec-Ch-Ua-Platform": '"Windows"' if "Windows" in ua else '"macOS"',
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-User": "?1",
        })
    elif is_firefox:
        headers["TE"] = "trailers"

    # 添加模拟 cookie
    headers["Cookie"] = _generate_ga_cookies()

    return headers


def _fetch_with_retry(client_headers: Dict, url: str, timeout: int = 20) -> httpx.Response:
    """
    反爬增强版请求：
    - 随机 UA 轮换（12+ 个 UA）
    - 随机延迟（1-3 秒）模拟真人
    - 模拟 Cookie（GA cookie）
    - Referer: google.com 模拟搜索引擎跳转
    - 403 后尝试 cloudscraper（绕过 Cloudflare/JS challenge）
    - 内容太少时也尝试 cloudscraper（SPA 网站壳页面检测）
    """
    import copy

    # 第一轮：用传入的 headers + 增强
    stealth_headers = _build_stealth_headers(url, client_headers.get("User-Agent"))
    # 合并原始 headers 中的非冲突项
    for k, v in client_headers.items():
        if k not in stealth_headers:
            stealth_headers[k] = v

    # 随机选择 2 个不同的 UA 尝试（减少尝试次数以加快速度）
    ua_pool = list(_FALLBACK_UAS)
    _random.shuffle(ua_pool)
    attempts_uas = [stealth_headers["User-Agent"]] + ua_pool[:2]

    last_resp = None
    for i, ua in enumerate(attempts_uas):
        if i > 0:
            # 随机延迟 1-2 秒
            delay = _random.uniform(1.0, 2.0)
            logger.info("[MerchantCrawler] 反爬延迟 %.1f 秒后重试 (UA #%d)", delay, i + 1)
            _time.sleep(delay)

        headers = _build_stealth_headers(url, ua)
        try:
            with httpx.Client(
                timeout=timeout,
                follow_redirects=True,
                headers=headers,
                http2=False,
            ) as client:
                resp = client.get(url)
                if resp.status_code != 403:
                    resp.raise_for_status()
                    # 检查是否是 SPA 壳页面（有 JS 但没有实际内容）
                    text_lower = resp.text.lower()
                    has_images = '<img' in text_lower
                    has_title = bool(re.search(r'<title>[^<]{3,}</title>', resp.text, re.IGNORECASE))
                    has_body_content = bool(re.search(r'<(?:main|article|section|div[^>]*class="[^"]*(?:product|content|hero))', text_lower))
                    content_score = (1 if has_images else 0) + (1 if has_title else 0) + (1 if has_body_content else 0)
                    
                    if content_score < 2:
                        logger.info("[MerchantCrawler] httpx 内容质量低 (score=%d, %d bytes, img=%s, title=%s)，尝试 cloudscraper",
                                    content_score, len(resp.text), has_images, has_title)
                        cs_resp = _try_cloudscraper(url, timeout)
                        if cs_resp is not None:
                            return cs_resp
                    return resp
                last_resp = resp
        except httpx.HTTPStatusError as e:
            if e.response and e.response.status_code == 403:
                last_resp = e.response
                continue
            raise
        except Exception:
            if i < len(attempts_uas) - 1:
                continue
            raise

    # 所有常规 UA 都 403，尝试 cloudscraper（绕过 Cloudflare/JS challenge）
    logger.info("[MerchantCrawler] 所有 UA 均 403，尝试 cloudscraper...")
    cs_resp = _try_cloudscraper(url, timeout)
    if cs_resp is not None:
        return cs_resp

    # 全部失败
    if last_resp is not None:
        last_resp.raise_for_status()
    raise httpx.HTTPStatusError("403 Forbidden", request=httpx.Request("GET", url), response=last_resp)


def _try_cloudscraper(url: str, timeout: int = 25):
    """
    使用 cloudscraper 绕过 Cloudflare/JS challenge。
    返回一个伪装成 httpx.Response 的对象，或 None。
    """
    try:
        import cloudscraper
    except ImportError:
        logger.warning("[MerchantCrawler] cloudscraper 未安装，跳过")
        return None

    try:
        _time.sleep(_random.uniform(0.5, 1.5))
        scraper = cloudscraper.create_scraper(
            browser={"browser": "chrome", "platform": "windows", "mobile": False}
        )
        # 去掉 brotli 编码，避免某些服务器的解压错误
        scraper.headers.update({
            "Accept-Encoding": "gzip, deflate",
            "Referer": "https://www.google.com/",
        })
        resp = scraper.get(url, timeout=timeout)
        if resp.status_code == 200 and len(resp.text) > 1000:
            logger.info("[MerchantCrawler] cloudscraper 成功! %d bytes", len(resp.text))
            # 包装成类似 httpx.Response 的对象
            fake_resp = httpx.Response(
                status_code=200,
                text=resp.text,
                headers=dict(resp.headers),
                request=httpx.Request("GET", url),
            )
            return fake_resp
        elif resp.status_code == 403:
            logger.warning("[MerchantCrawler] cloudscraper 也被 403")
        else:
            logger.warning("[MerchantCrawler] cloudscraper 返回 %d, %d bytes", resp.status_code, len(resp.text))
    except Exception as e:
        logger.warning("[MerchantCrawler] cloudscraper 失败: %s", e)

    # cloudscraper 失败时，尝试 plain requests（有些网站对 requests 更友好）
    try:
        import requests as _requests
        _time.sleep(_random.uniform(0.5, 1.0))
        session = _requests.Session()
        session.headers.update({
            "User-Agent": _random.choice(_FALLBACK_UAS),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.google.com/",
        })
        resp = session.get(url, timeout=timeout, allow_redirects=True)
        if resp.status_code == 200 and len(resp.text) > 5000:
            logger.info("[MerchantCrawler] requests fallback 成功! %d bytes", len(resp.text))
            fake_resp = httpx.Response(
                status_code=200,
                text=resp.text,
                headers=dict(resp.headers),
                request=httpx.Request("GET", url),
            )
            return fake_resp
    except Exception as e:
        logger.warning("[MerchantCrawler] requests fallback 也失败: %s", e)

    return None


def crawl(url: str) -> Dict:
    """
    爬取商家网站。返回结构化数据。
    爬取失败时返回 crawl_failed=True。
    """
    try:
        url = _validate_url(url)
    except ValueError as e:
        return {"crawl_failed": True, "error": str(e), "url": url}

    pages = []
    brand_name = ""

    try:
        resp = _fetch_with_retry(HEADERS, url)
        home_html = resp.text

        home_data = _extract_page(home_html, url)
        pages.append(home_data)
        brand_name = home_data["og_site_name"] or home_data["title"].split("|")[0].split("-")[0].strip()

        home_soup = BeautifulSoup(home_html, "lxml")
        sub_urls = _find_sub_pages(home_soup, url)

        for sub_url in sub_urls[:8]:
            try:
                # 子页面之间随机延迟，降低反爬触发
                _time.sleep(_random.uniform(1.0, 2.5))
                resp = _fetch_with_retry(HEADERS, sub_url, timeout=12)
                sub_data = _extract_page(resp.text, sub_url)
                pages.append(sub_data)
            except Exception as e:
                logger.warning(f"[MerchantCrawler] 子页面爬取失败 {sub_url}: {e}")

    except httpx.TimeoutException:
        logger.error(f"[MerchantCrawler] 爬取超时 {url}")
        return {"crawl_failed": True, "error": f"商家网站访问超时，该网站可能较慢或服务器无法访问", "url": url}
    except httpx.HTTPStatusError as e:
        status = e.response.status_code if e.response else 0
        logger.error(f"[MerchantCrawler] HTTP {status} {url}: {e}")
        if status == 403:
            return {"crawl_failed": True, "error": f"商家网站拒绝访问 (403)，该网站有反爬保护。可尝试手动输入商家信息。", "url": url}
        return {"crawl_failed": True, "error": f"商家网站返回 HTTP {status} 错误", "url": url}
    except httpx.ConnectError:
        logger.error(f"[MerchantCrawler] 连接失败 {url}")
        return {"crawl_failed": True, "error": f"无法连接到商家网站，请检查网址是否正确", "url": url}
    except Exception as e:
        logger.error(f"[MerchantCrawler] 爬取失败 {url}: {e}")
        return {"crawl_failed": True, "error": str(e), "url": url}

    raw_text = "\n\n".join(
        f"[{p['title']}]\n{p['text']}" for p in pages
    )[:8000]

    total_images = sum(len(p.get("images", [])) for p in pages)
    logger.info(
        "[MerchantCrawler] 爬取完成 %s: %d 页, %d 张图片, brand=%s",
        url, len(pages), total_images, brand_name,
    )

    return {
        "crawl_failed": False,
        "brand_name": brand_name,
        "url": url,
        "pages": pages,
        "raw_text": raw_text,
    }


def search_images(query: str, count: int = 12,
                  brand_name: str = "", category: str = "") -> List[str]:
    """
    搜索可商用的高清图片作为补充。
    优先使用 Pexels API（免费可商用），fallback 到 Unsplash URL 拼接。
    所有返回图片均可免费商用，无需署名。

    改进：多轮搜索策略，确保图片与商家高度相关
    - 第1轮：品牌名 + 产品关键词（最精准）
    - 第2轮：产品品类 + lifestyle 关键词（软植入风格）
    - 第3轮：原始 query（兜底）
    """
    from app.config import settings

    # 构建多轮搜索词
    search_queries = []
    if brand_name and category:
        search_queries.append(f"{brand_name} {category} product")
    if brand_name:
        search_queries.append(f"{brand_name} lifestyle")
    if category:
        search_queries.append(f"{category} high quality product photography")
    if query and query not in search_queries:
        search_queries.append(query)
    if not search_queries:
        search_queries = [query or "product lifestyle"]

    images = []
    seen = set()

    for sq in search_queries:
        if len(images) >= count:
            break
        remaining = count - len(images)
        batch = _search_images_single(sq, remaining + 6, settings)
        for img in batch:
            if img not in seen:
                seen.add(img)
                images.append(img)
            if len(images) >= count:
                break

    return images[:count]


def _search_images_single(query: str, count: int, settings) -> List[str]:
    """单次图库搜索（Pexels + Unsplash）"""
    images = []

    # ===== 方案1: Pexels API（推荐，高质量可商用）=====
    pexels_key = getattr(settings, "PEXELS_API_KEY", "")
    if pexels_key:
        try:
            with httpx.Client(timeout=15, follow_redirects=True) as client:
                resp = client.get(
                    "https://api.pexels.com/v1/search",
                    params={"query": query, "per_page": min(count * 2, 40),
                            "size": "large", "orientation": "landscape"},
                    headers={"Authorization": pexels_key},
                )
                resp.raise_for_status()
                data = resp.json()
                for photo in data.get("photos", []):
                    # 只取宽度 >= 1200 的高清图
                    src = photo.get("src", {})
                    w = photo.get("width", 0)
                    h = photo.get("height", 0)
                    if w < 1200 or h < 800:
                        continue
                    url = src.get("large2x") or src.get("large") or src.get("original")
                    if url and url not in images:
                        images.append(url)
            logger.info(f"[ImageSearch] Pexels '{query}' -> {len(images)} 张高清图")
        except Exception as e:
            logger.warning(f"[ImageSearch] Pexels 搜索失败 '{query}': {e}")

    # ===== 方案2: Unsplash Source URL 拼接（免费可商用，无需 API Key）=====
    if len(images) < count:
        try:
            with httpx.Client(timeout=15, follow_redirects=True, headers=HEADERS) as client:
                resp = client.get(
                    "https://unsplash.com/napi/search/photos",
                    params={"query": query, "per_page": min(count * 2, 30),
                            "orientation": "landscape"},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    for result in data.get("results", []):
                        urls = result.get("urls", {})
                        w = result.get("width", 0)
                        h = result.get("height", 0)
                        if w < 1200 or h < 800:
                            continue
                        url = urls.get("regular") or urls.get("full")
                        if url and url not in images:
                            images.append(url)
                    logger.info(f"[ImageSearch] Unsplash '{query}' 补充后共 {len(images)} 张")
        except Exception as e:
            logger.warning(f"[ImageSearch] Unsplash 搜索失败 '{query}': {e}")

    return images
