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

PRODUCT_PAGE_KEYWORDS = [
    "product", "shop", "store", "collection", "collections",
    "catalog", "item", "new-arrival", "best-seller", "bestseller",
    "all-products", "featured", "new-in",
]

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

# 被排除的图片扩展名/类型（非内容图片）
_JUNK_IMG_PATTERNS = re.compile(
    r'(?:'
    r'\.gif(?:\?|$)'                        # GIF 通常是动图/追踪像素
    r'|\.svg(?:\?|$)'                       # SVG 通常是图标
    r'|/(?:pixel|spacer|blank|1x1|clear)\.' # 透明像素
    r'|(?:_|-)(?:16|24|32|48|64|72)x'       # 极小缩略图 (24x24, 32x32 等)
    r'|/(?:icon|logo|badge|flag)s?[/_\-.]'  # 图标/logo 路径
    r'|/emoji/'                             # Emoji 图片
    r'|gravatar\.com'                       # 用户头像
    r'|\.ico(?:\?|$)'                       # favicon
    r')',
    re.IGNORECASE,
)


def _is_quality_image(url: str) -> bool:
    """判断 URL 是否指向高质量内容图片（排除图标、追踪像素、极小缩略图等）"""
    if _JUNK_IMG_PATTERNS.search(url):
        return False
    # 图片 URL 至少需要有合理的文件扩展名
    url_lower = url.lower().split('?')[0]
    valid_exts = ('.jpg', '.jpeg', '.png', '.webp', '.avif')
    if not any(url_lower.endswith(ext) for ext in valid_exts):
        # 允许没有扩展名但来自已知 CDN 的 URL（Shopify/Cloudinary 等）
        cdn_patterns = ['cdn.shopify', 'cloudinary', 'imgix', 'cloudfront',
                        'squarespace', 'wixstatic', 'bigcommerce', 'pexels.com',
                        'unsplash.com', 'images.unsplash']
        if not any(p in url_lower for p in cdn_patterns):
            return False
    return True

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
        "Chrome/135.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Sec-Ch-Ua": '"Chromium";v="135", "Google Chrome";v="135", "Not-A.Brand";v="99"',
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


def _normalize_url(url: str) -> str:
    """标准化 URL：补协议、清追踪参数、统一格式"""
    url = url.strip()
    if not url:
        raise ValueError("URL 为空")

    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    parsed = urlparse(url)
    # 清理常见追踪参数，保留核心路径
    clean_params = []
    if parsed.query:
        from urllib.parse import parse_qs, urlencode
        tracking_keys = {
            "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
            "fbclid", "gclid", "ref", "affiliate", "aff_id", "click_id",
            "mc_cid", "mc_eid", "s_kwcid", "msclkid",
        }
        qs = parse_qs(parsed.query, keep_blank_values=False)
        clean_params = [(k, v[0]) for k, v in qs.items() if k.lower() not in tracking_keys]

    from urllib.parse import urlencode as _ue
    clean_query = _ue(clean_params) if clean_params else ""
    path = parsed.path or "/"

    url = f"{parsed.scheme}://{parsed.netloc}{path}"
    if clean_query:
        url += f"?{clean_query}"

    return url


def _validate_url(url: str) -> str:
    """SSRF 防护 + URL 标准化"""
    url = _normalize_url(url)
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
        # DNS 解析失败时尝试 www/non-www 变体
        alt_hostname = hostname
        if hostname.startswith("www."):
            alt_hostname = hostname[4:]
        else:
            alt_hostname = "www." + hostname
        try:
            socket.gethostbyname(alt_hostname)
            url = url.replace(hostname, alt_hostname, 1)
            logger.info("[MerchantCrawler] DNS 回退: %s → %s", hostname, alt_hostname)
        except socket.gaierror:
            raise ValueError(f"域名 {hostname} 无法解析，请检查网址")
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
    Shopify: 移除 height=16/width=100 等小尺寸参数，替换为合理大小
    其他 CDN: 移除明显的缩略图尺寸参数
    """
    import re
    from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

    upgraded = []
    for img_url in images:
        url_lower = img_url.lower()

        if "cdn.shopify" in url_lower or "/cdn/shop/" in url_lower:
            parsed = urlparse(img_url)
            qs = parse_qs(parsed.query, keep_blank_values=False)

            # 移除小尺寸参数，用合理值替代
            changed = False
            for size_key in ("width", "height", "w", "h"):
                if size_key in qs:
                    try:
                        val = int(qs[size_key][0])
                        if val < 400:
                            del qs[size_key]
                            changed = True
                    except (ValueError, IndexError):
                        pass

            # 移除 crop 参数（会限制图片区域）
            if "crop" in qs:
                del qs["crop"]
                changed = True

            # 确保有合理尺寸
            if changed and "width" not in qs and "height" not in qs:
                qs["width"] = ["800"]

            if changed:
                new_query = urlencode({k: v[0] for k, v in qs.items()})
                new_url = urlunparse((parsed.scheme, parsed.netloc, parsed.path,
                                     parsed.params, new_query, parsed.fragment))
            else:
                new_url = img_url

            # 替换 Shopify 尺寸后缀 (如 _450x450)
            new_url = re.sub(r'_\d+x\d+\.', '.', new_url)
            upgraded.append(new_url)

        elif any(cdn in url_lower for cdn in ["squarespace", "wixstatic", "imgix"]):
            # 移除其他 CDN 的小尺寸参数
            new_url = re.sub(r'[?&](?:w|h|width|height)=\d{1,3}(?=&|$)', '', img_url)
            new_url = new_url.rstrip('?&')
            upgraded.append(new_url if new_url else img_url)
        else:
            upgraded.append(img_url)

    seen = set()
    result = []
    for url in upgraded:
        if url not in seen:
            seen.add(url)
            result.append(url)
    return result


def _find_sub_pages(soup: BeautifulSoup, base_url: str) -> List[str]:
    """从首页链接中发现关键子页面 — 产品页优先"""
    parsed_base = urlparse(base_url)
    product_pages = []    # 产品/商品页（最高优先级）
    priority_pages = []   # 其他关键词匹配的高优先级页面
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

        if any(kw in path_lower for kw in PRODUCT_PAGE_KEYWORDS):
            product_pages.append(full)
        elif any(kw in path_lower for kw in SUB_PAGE_KEYWORDS):
            priority_pages.append(full)
        else:
            other_pages.append(full)

    # 产品页最优先，其次关键词页，最后其他内部页面
    result = product_pages[:15] + priority_pages[:12] + other_pages[:8]
    return result[:30]


_FALLBACK_UAS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:136.0) Gecko/20100101 Firefox/136.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
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
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Upgrade-Insecure-Requests": "1",
        "Referer": "https://www.google.com/",
        "DNT": "1",
        "Connection": "keep-alive",
    }

    if not is_firefox and not is_safari:
        chrome_ver = "135"
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
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
        })
    elif is_firefox:
        headers["TE"] = "trailers"

    # 添加模拟 cookie
    headers["Cookie"] = _generate_ga_cookies()

    return headers


def _make_httpx_response(text: str, url: str, headers: dict = None) -> httpx.Response:
    """将爬取结果包装成 httpx.Response 兼容对象"""
    return httpx.Response(
        status_code=200,
        text=text,
        headers=headers or {},
        request=httpx.Request("GET", url),
    )


def _is_blocked_page(html: str) -> bool:
    """检测是否是反爬/challenge 拦截页（Cloudflare 5s shield, CAPTCHA 等）

    设计原则：
    - 大页面（>50KB）且有结构化标签的几乎不可能是拦截页，直接放行
    - 强信号（Cloudflare challenge 专属文本）只在小页面时才触发
    - 弱信号（captcha/cloudflare/blocked 等）在正常网站中普遍存在，不应单独触发
    """
    text_lower = html.lower()
    page_len = len(html)

    has_main = "<main" in text_lower
    has_article = "<article" in text_lower
    has_product = re.search(r'class="[^"]*product', text_lower) is not None
    has_img = text_lower.count("<img") >= 3

    if page_len > 50000 and (has_main or has_article or has_product) and has_img:
        return False

    strong_signals = [
        "checking your browser",
        "just a moment",
        "enable javascript and cookies",
        "cf-browser-verification",
        "challenge-platform",
        "please verify you are a human",
        "please complete the security check",
        "are you a robot",
        "cf-challenge-running",
        "access denied",
        "you don't have permission",
        "errors.edgesuite.net",
        "request blocked",
        "forbidden",
    ]
    strong_hits = sum(1 for s in strong_signals if s in text_lower)

    if strong_hits >= 1 and page_len < 30000 and not has_main and not has_article:
        return True

    if strong_hits >= 2 and page_len < 80000:
        return True

    return False

def _content_quality_score(html: str) -> int:
    """检测 HTML 内容质量（0-4）。
    放宽标准以适应各类网站，包括 SPA、Shopify、WordPress 等。
    """
    if _is_blocked_page(html):
        return 0

    content_len = len(html)
    if content_len > 80000:
        return 4

    text_lower = html.lower()
    score = 0

    if '<img' in text_lower or 'data-src' in text_lower or 'srcset' in text_lower:
        score += 1
    if re.search(r'<title>[^<]{3,}</title>', html, re.IGNORECASE):
        score += 1
    if re.search(
        r'<(?:main|article|section|div[^>]*class="[^"]*(?:product|content|hero|shop|item|card|grid|page))',
        text_lower
    ):
        score += 1

    spa_signals = [
        'id="app"', 'id="root"', 'id="__next"', 'id="__nuxt"',
        'data-reactroot', 'ng-app', 'v-app',
        '"application/json"', '__NEXT_DATA__', '__NUXT__',
        'window.__INITIAL_STATE__', 'window.__PRELOADED_STATE__',
    ]
    if any(sig in html for sig in spa_signals):
        score += 1

    if content_len > 30000 and score >= 1:
        score = max(score, 2)
    if content_len > 50000:
        score = max(score, 2)

    if re.search(r'<(?:script|link)[^>]*(?:chunk|bundle|vendor|app\.[a-f0-9])', text_lower):
        score = max(score, 2)

    return score


def _try_curl_cffi(url: str, timeout: int = 20):
    """
    Level 1: curl_cffi — 模拟真实浏览器 TLS/JA3 指纹。
    这是绕过 TLS 指纹检测最有效的方案。
    """
    try:
        from curl_cffi import requests as cffi_requests
    except ImportError:
        logger.debug("[MerchantCrawler] curl_cffi 未安装，跳过")
        return None

    impersonate_targets = ["chrome131", "chrome133", "safari18_0", "edge131"]
    _random.shuffle(impersonate_targets)

    best_result = None
    best_score = -1

    for target in impersonate_targets[:3]:
        try:
            _time.sleep(_random.uniform(0.3, 1.0))
            resp = cffi_requests.get(
                url,
                impersonate=target,
                timeout=timeout,
                allow_redirects=True,
                headers={
                    "Accept-Language": "en-US,en;q=0.9",
                    "Referer": "https://www.google.com/",
                    "DNT": "1",
                },
            )
            if resp.status_code == 200 and len(resp.text) > 500:
                score = _content_quality_score(resp.text)
                # 大页面(>50KB)降低质量门槛
                min_score = 1 if len(resp.text) > 50000 else 2
                if score >= min_score:
                    logger.info("[MerchantCrawler] curl_cffi(%s) 成功! %d bytes, quality=%d",
                                target, len(resp.text), score)
                    return _make_httpx_response(resp.text, url, dict(resp.headers))
                if score > best_score:
                    best_score = score
                    best_result = _make_httpx_response(resp.text, url, dict(resp.headers))
                logger.info("[MerchantCrawler] curl_cffi(%s) 质量低 (score=%d)", target, score)
            elif resp.status_code == 403:
                logger.info("[MerchantCrawler] curl_cffi(%s) 被 403", target)
            else:
                logger.info("[MerchantCrawler] curl_cffi(%s) 返回 %d", target, resp.status_code)
        except Exception as e:
            logger.debug("[MerchantCrawler] curl_cffi(%s) 失败: %s", target, e)

    # 如果有低分但有内容的结果，返回它（比没有强）
    if best_result and best_score >= 1:
        logger.info("[MerchantCrawler] curl_cffi 使用最佳低分结果 (score=%d)", best_score)
        return best_result

    return None


_PLAYWRIGHT_SCRIPT = r'''
import sys, json, time, random
url, timeout_s, ua = sys.argv[1], int(sys.argv[2]), sys.argv[3]
try:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox", "--disable-dev-shm-usage",
                "--disable-web-security",
                "--disable-features=VizDisplayCompositor",
                "--disable-infobars",
                "--window-size=1920,1080",
                "--disable-extensions",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
            ])
        ctx = browser.new_context(
            user_agent=ua,
            viewport={"width": 1920, "height": 1080},
            locale="en-US", timezone_id="America/New_York",
            java_script_enabled=True,
            bypass_csp=True,
            extra_http_headers={
                "Accept-Language": "en-US,en;q=0.9",
                "DNT": "1",
            })
        ctx.add_init_script("""
            // --- Webdriver & automation detection ---
            Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
            delete navigator.__proto__.webdriver;
            Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
            Object.defineProperty(navigator,'plugins',{get:()=>[
                {name:'Chrome PDF Plugin',filename:'internal-pdf-viewer'},
                {name:'Chrome PDF Viewer',filename:'mhjfbmdgcfjbbpaeojofohoefgiehjai'},
                {name:'Native Client',filename:'internal-nacl-plugin'},
            ]});
            Object.defineProperty(navigator,'maxTouchPoints',{get:()=>0});
            Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>8});
            Object.defineProperty(navigator,'deviceMemory',{get:()=>8});
            Object.defineProperty(navigator,'platform',{get:()=>'Win32'});

            // --- Chrome runtime ---
            window.chrome = {runtime: {}, loadTimes: function(){return{}}, csi: function(){return{}}};

            // --- Permissions API ---
            const origQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (params) =>
                params.name === 'notifications'
                    ? Promise.resolve({state: Notification.permission})
                    : origQuery(params);

            // --- WebGL vendor ---
            const getParam = WebGLRenderingContext.prototype.getParameter;
            WebGLRenderingContext.prototype.getParameter = function(p) {
                if (p === 37445) return 'Intel Inc.';
                if (p === 37446) return 'Intel Iris OpenGL Engine';
                return getParam.call(this, p);
            };

            // --- iframe contentWindow ---
            const origAttachShadow = Element.prototype.attachShadow;
            Element.prototype.attachShadow = function(init) {
                return origAttachShadow.call(this, {...init, mode: 'open'});
            };
        """)
        page = ctx.new_page()

        # Intercept common tracking/analytics to speed up page load
        page.route("**/{analytics,gtag,fbevents,hotjar,segment,mixpanel}*", lambda route: route.abort())

        try:
            page.goto(url, wait_until="domcontentloaded", timeout=timeout_s*1000)
        except Exception:
            pass  # timeout on goto is non-fatal, page may have partial content

        time.sleep(random.uniform(1.5, 3.0))

        # --- Cloudflare Turnstile / challenge wait ---
        challenge_detected = False
        body_text = page.evaluate("document.body?.innerText || ''").lower()
        if any(s in body_text for s in ["checking your browser", "just a moment", "verify you are human"]):
            challenge_detected = True
            for _ in range(12):  # wait up to ~18s for challenge to auto-resolve
                time.sleep(1.5)
                body_text = page.evaluate("document.body?.innerText || ''").lower()
                if not any(s in body_text for s in ["checking your browser", "just a moment", "verify you are human"]):
                    break
                # Try clicking Turnstile checkbox if visible
                try:
                    turnstile = page.locator('iframe[src*="challenges.cloudflare.com"]').first
                    if turnstile.is_visible(timeout=500):
                        frame = turnstile.content_frame()
                        if frame:
                            checkbox = frame.locator('input[type="checkbox"], .cb-i').first
                            if checkbox.is_visible(timeout=500):
                                checkbox.click(timeout=1000)
                                time.sleep(2)
                except Exception:
                    pass

        # --- Dismiss cookie/consent banners ---
        consent_selectors = [
            'button:has-text("Accept")', 'button:has-text("I agree")',
            'button:has-text("Got it")', 'button:has-text("OK")',
            'button:has-text("Accept All")', 'button:has-text("Accept Cookies")',
            'button:has-text("Allow")', 'button:has-text("Agree")',
            'button:has-text("Continue")',
            '[id*="accept"]', '[class*="accept"]',
            '[id*="consent"] button', '[class*="consent"] button',
            '[id*="cookie"] button', '[class*="cookie"] button',
        ]
        for sel in consent_selectors:
            try:
                btn = page.locator(sel).first
                if btn.is_visible(timeout=300):
                    btn.click(timeout=1000)
                    time.sleep(0.3)
                    break
            except Exception:
                pass

        # --- Wait for content ---
        try:
            page.wait_for_selector(
                "img, main, article, .product, [class*='product'], [class*='hero'], [class*='collection']",
                timeout=8000)
        except Exception:
            pass

        # --- Scroll to trigger lazy-loaded images ---
        try:
            total_height = page.evaluate("document.body.scrollHeight") or 3000
            step = max(total_height // 6, 300)
            for y in range(0, total_height + step, step):
                page.evaluate(f"window.scrollTo(0, {y})")
                time.sleep(random.uniform(0.3, 0.6))
            time.sleep(random.uniform(0.8, 1.5))
            page.evaluate("window.scrollTo(0, 0)")
            time.sleep(0.3)
        except Exception:
            pass

        html = page.content()
        browser.close()
        sys.stdout.buffer.write(html.encode("utf-8"))
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
'''


def _try_playwright(url: str, timeout: int = 30):
    """
    Level 3: Playwright 无头浏览器 — 在独立子进程中运行。
    使用 subprocess 彻底隔离 asyncio event loop，避免 Sync API 冲突。
    """
    import subprocess as _sp
    import shutil
    import tempfile
    import os

    python_cmd = shutil.which("python3") or shutil.which("python")
    if not python_cmd:
        logger.debug("[MerchantCrawler] python3/python 不在 PATH 中，跳过 playwright")
        return None

    # 写入临时脚本文件而非用 -c 参数，避免参数长度限制和转义问题
    script_fd, script_path = tempfile.mkstemp(suffix=".py", prefix="pw_crawl_")
    try:
        os.write(script_fd, _PLAYWRIGHT_SCRIPT.encode("utf-8"))
        os.close(script_fd)

        desktop_uas = [ua for ua in _FALLBACK_UAS if "Mobile" not in ua and "iPhone" not in ua]
        ua = _random.choice(desktop_uas) if desktop_uas else _FALLBACK_UAS[0]
        proc = _sp.run(
            [python_cmd, script_path, url, str(timeout), ua],
            capture_output=True, timeout=timeout + 30,
        )
        html = proc.stdout.decode("utf-8", errors="replace")

        if proc.returncode != 0:
            err_msg = proc.stderr.decode("utf-8", errors="replace")[:500]
            logger.warning("[MerchantCrawler] playwright 子进程失败: %s", err_msg)
            if "playwright" in err_msg.lower() and "install" in err_msg.lower():
                logger.error("[MerchantCrawler] Playwright 浏览器未安装！请在服务器执行: playwright install chromium")
            return None

        if html and len(html) > 500:
            score = _content_quality_score(html)
            if score >= 1 or len(html) > 5000:
                logger.info("[MerchantCrawler] playwright 成功! %d bytes, quality=%d",
                            len(html), score)
                return _make_httpx_response(html, url)
        logger.info("[MerchantCrawler] playwright 返回内容过短 (%d bytes)", len(html))
    except _sp.TimeoutExpired:
        logger.warning("[MerchantCrawler] playwright 超时 (%ds)", timeout)
    except Exception as e:
        logger.warning("[MerchantCrawler] playwright 失败: %s", e)
    finally:
        try:
            os.unlink(script_path)
        except OSError:
            pass

    return None


def _detect_site_difficulty(url: str, html: str = "") -> str:
    """根据 URL 和初次响应快速判断站点爬取难度。
    返回: 'easy', 'medium', 'hard'
    """
    url_lower = url.lower()
    hard_platforms = [
        "shopify.com", "myshopify.com", "squarespace.com",
        "wix.com", "webflow.io",
    ]
    if any(p in url_lower for p in hard_platforms):
        return "medium"

    if not html:
        return "easy"

    html_lower = html.lower()

    # Cloudflare challenge page (small response with CF markers)
    if "cf-ray" in html_lower and len(html) < 5000:
        return "hard"
    if "cf-challenge-running" in html_lower:
        return "hard"

    # SPA without server-rendered images → needs JS rendering
    spa_hints = ['id="app"', 'id="root"', 'id="__next"', '__NEXT_DATA__', 'data-reactroot']
    if any(h in html for h in spa_hints) and '<img' not in html_lower:
        return "hard"

    # Platform detection from HTML meta/generator tags
    shopify_hints = [
        "cdn.shopify.com", "shopify.com/s/files", "myshopify.com",
        'name="shopify-', "shopify-section", "shopify-payment",
        "Shopify.theme",
    ]
    if any(h in html for h in shopify_hints):
        return "medium"

    wp_hints = ['name="generator" content="WordPress', "wp-content/", "wp-includes/"]
    if any(h in html for h in wp_hints) and html_lower.count("<img") >= 3:
        return "easy"

    wix_hints = ["wix.com", "parastorage.com", "wixstatic.com"]
    if any(h in html_lower for h in wix_hints):
        return "medium"

    bigcommerce_hints = ["bigcommerce.com", "cdn11.bigcommerce.com"]
    if any(h in html_lower for h in bigcommerce_hints):
        return "medium"

    return "easy"


def _detect_platform(html: str) -> str:
    """从 HTML 特征检测网站平台，用于调整图片提取策略。
    返回: 'shopify', 'wordpress', 'wix', 'squarespace', 'next', 'generic'
    """
    if not html:
        return "generic"
    if any(s in html for s in ["cdn.shopify.com", "Shopify.theme", "shopify-section"]):
        return "shopify"
    if any(s in html for s in ["wp-content/", "wp-includes/"]):
        return "wordpress"
    if any(s in html.lower() for s in ["wixstatic.com", "parastorage.com"]):
        return "wix"
    if any(s in html for s in ["squarespace.com", "squarespace-cdn"]):
        return "squarespace"
    if "__NEXT_DATA__" in html or 'id="__next"' in html:
        return "next"
    return "generic"


def _try_google_cache(url: str, timeout: int = 15):
    """尝试从 Google 缓存 / Wayback Machine 获取页面内容"""
    from urllib.parse import quote
    import datetime
    current_year = datetime.datetime.now().year

    parsed_target = urlparse(url)
    target_domain = parsed_target.netloc.replace("www.", "").split(".")[0].lower()

    cache_urls = [
        f"https://webcache.googleusercontent.com/search?q=cache:{quote(url)}",
        f"https://web.archive.org/web/{current_year}/{url}",
        f"https://web.archive.org/web/{current_year - 1}/{url}",
    ]
    for cache_url in cache_urls:
        try:
            headers = _build_stealth_headers(cache_url)
            with httpx.Client(timeout=timeout, follow_redirects=True, headers=headers) as client:
                resp = client.get(cache_url)
                if resp.status_code == 200 and len(resp.text) > 3000:
                    if _is_blocked_page(resp.text):
                        continue

                    html_lower = resp.text.lower()

                    # Google Cache 验证：确保返回的是目标站点内容而非搜索结果页
                    if "webcache.googleusercontent.com" in cache_url:
                        is_google_search = (
                            'id="search"' in html_lower
                            or "google.com/search" in html_lower
                            or '<title>google' in html_lower[:500]
                        )
                        has_target_content = target_domain in html_lower
                        if is_google_search and not has_target_content:
                            logger.warning("[MerchantCrawler] Google Cache 返回搜索结果页而非缓存，跳过")
                            continue

                    # Wayback Machine: 确保不是 archive.org 的错误页
                    if "web.archive.org" in cache_url:
                        if "wayback machine" in html_lower and len(resp.text) < 10000:
                            continue

                    logger.info("[MerchantCrawler] Google/Archive 缓存命中! %d bytes", len(resp.text))
                    return _make_httpx_response(resp.text, url)
        except Exception as e:
            logger.debug("[MerchantCrawler] 缓存获取失败 %s: %s", cache_url[:60], e)
    return None


def _fetch_with_retry(client_headers: Dict, url: str, timeout: int = 20) -> httpx.Response:
    """
    多级反爬回退请求策略（智能版）：
      Level 0: httpx + 隐身 headers（快速，大部分网站可过）
      Level 1: curl_cffi + TLS 指纹伪装（绕过 TLS/JA3 检测）
      Level 2: cloudscraper（绕过旧版 Cloudflare）
      Level 3: Playwright 无头浏览器（最终手段）
      Level 4: Google Cache / Wayback Machine（应急）

    智能优化：
      - 首次请求快速判断站点难度
      - 难站点跳过中间层直接用 Playwright
      - 保留所有获得的最佳结果作为兜底
    """
    best_resp = None
    best_score = -1

    def _update_best(resp):
        nonlocal best_resp, best_score
        if resp and hasattr(resp, 'text'):
            s = _content_quality_score(resp.text)
            if s > best_score:
                best_score = s
                best_resp = resp

    # ── Level 0: httpx stealth ──
    ua_pool = list(_FALLBACK_UAS)
    _random.shuffle(ua_pool)
    attempts_uas = [client_headers.get("User-Agent", ua_pool[0])] + ua_pool[:2]

    difficulty = "easy"
    got_403 = False

    for i, ua in enumerate(attempts_uas):
        if i > 0:
            _time.sleep(_random.uniform(0.5, 1.0))

        headers = _build_stealth_headers(url, ua)
        try:
            with httpx.Client(
                timeout=timeout,
                follow_redirects=True,
                headers=headers,
                http2=True,
            ) as client:
                resp = client.get(url)
                if resp.status_code == 403:
                    got_403 = True
                    _update_best(resp)
                    continue
                resp.raise_for_status()
                score = _content_quality_score(resp.text)
                _update_best(resp)
                if score >= 2:
                    return resp

                difficulty = _detect_site_difficulty(url, resp.text)
                if difficulty == "hard":
                    logger.info("[MerchantCrawler] 检测到困难站点，跳至 Playwright")
                    break
                logger.info("[MerchantCrawler] httpx 质量低 (score=%d, %d bytes)，升级",
                            score, len(resp.text))
                break
        except httpx.HTTPStatusError as e:
            if e.response and e.response.status_code == 403:
                got_403 = True
                _update_best(e.response)
                continue
            raise
        except Exception:
            if i < len(attempts_uas) - 1:
                continue
            break

    # 403 几乎肯定是反爬检测，标记为困难
    if got_403:
        difficulty = "hard"

    # 困难站点：跳过 Level 1-2，直接用 Playwright
    if difficulty == "hard":
        logger.info("[MerchantCrawler] 困难站点，直接尝试 Playwright (Level 3)...")
        result = _try_playwright(url, timeout + 15)
        if result is not None:
            return result
        # Playwright 也失败，再尝试 curl_cffi 和 cloudscraper
        logger.info("[MerchantCrawler] Playwright 失败，回退到 curl_cffi...")
        result = _try_curl_cffi(url, timeout)
        if result is not None:
            return result
        result = _try_cloudscraper(url, timeout)
        if result is not None:
            return result
    else:
        # 普通站点：按顺序尝试
        logger.info("[MerchantCrawler] 尝试 curl_cffi (Level 1)...")
        result = _try_curl_cffi(url, timeout)
        if result is not None:
            return result

        logger.info("[MerchantCrawler] 尝试 cloudscraper (Level 2)...")
        result = _try_cloudscraper(url, timeout)
        if result is not None:
            return result

        logger.info("[MerchantCrawler] 尝试 Playwright (Level 3)...")
        result = _try_playwright(url, timeout + 10)
        if result is not None:
            return result

    # ── Level 4: Google Cache / Wayback Machine ──
    logger.info("[MerchantCrawler] 所有直接方案失败，尝试 Google Cache (Level 4)...")
    result = _try_google_cache(url, timeout)
    if result is not None:
        return result

    # 全部失败：返回最佳低质量结果而非抛出异常
    if best_resp is not None and best_score >= 1:
        logger.warning("[MerchantCrawler] 所有方案失败，使用最佳低质量结果 (score=%d, %d bytes)",
                       best_score, len(getattr(best_resp, 'text', '')))
        return best_resp

    if best_resp is not None and hasattr(best_resp, 'text') and len(best_resp.text) > 2000:
        logger.warning("[MerchantCrawler] 使用低分但有内容的结果 (%d bytes)", len(best_resp.text))
        return best_resp

    if best_resp is not None:
        best_resp.raise_for_status()

    raise httpx.HTTPStatusError("403 Forbidden", request=httpx.Request("GET", url), response=best_resp)


def _try_cloudscraper(url: str, timeout: int = 25):
    """
    Level 2: cloudscraper 绕过 Cloudflare/JS challenge。
    修复：处理 gzip 解压错误（某些服务器返回错误的 Content-Encoding）
    """
    try:
        import cloudscraper
    except (ImportError, Exception) as exc:
        logger.debug("[MerchantCrawler] cloudscraper 不可用: %s", exc)
        return None

    for attempt in range(2):
        try:
            _time.sleep(_random.uniform(0.5, 1.5))
            scraper = cloudscraper.create_scraper(
                browser={"browser": "chrome", "platform": "windows", "mobile": False}
            )
            headers = {
                "Referer": "https://www.google.com/",
            }
            if attempt == 0:
                headers["Accept-Encoding"] = "gzip, deflate"
            else:
                # 第二次尝试不发 Accept-Encoding，避免解压错误
                headers["Accept-Encoding"] = "identity"
            scraper.headers.update(headers)
            resp = scraper.get(url, timeout=timeout)
            if resp.status_code == 200 and len(resp.text) > 1000:
                score = _content_quality_score(resp.text)
                if score >= 2:
                    logger.info("[MerchantCrawler] cloudscraper 成功! %d bytes, quality=%d", len(resp.text), score)
                    return _make_httpx_response(resp.text, url, dict(resp.headers))
                logger.info("[MerchantCrawler] cloudscraper 质量低 (score=%d)", score)
            elif resp.status_code == 403:
                logger.info("[MerchantCrawler] cloudscraper 被 403")
                break
        except Exception as e:
            err_str = str(e)
            if "decompressing" in err_str.lower() or "zlib" in err_str.lower():
                logger.info("[MerchantCrawler] cloudscraper 解压错误，重试 identity 编码")
                continue
            logger.warning("[MerchantCrawler] cloudscraper 失败: %s", e)
            break

    return None


def _playwright_image_rescue(url: str, timeout: int = 30) -> List[str]:
    """当普通爬取获得内容但 0 图片时，用 Playwright 补爬图片。
    仅提取图片 URL，不替换已有内容。
    """
    logger.info("[MerchantCrawler] 0 图片补爬: 启动 Playwright 提取图片 %s", url)
    resp = _try_playwright(url, timeout)
    if resp is None:
        return []

    page_data = _extract_page(resp.text, url)
    images = page_data.get("images", [])
    logger.info("[MerchantCrawler] Playwright 补爬获得 %d 张图片", len(images))
    return images


def crawl(url: str) -> Dict:
    """
    爬取商家网站，返回结构化数据。
    设计原则：
    - 尽最大努力返回有价值的数据，即使部分失败
    - 0 图片时自动用 Playwright 补爬
    - 超时/错误时保留已有部分结果
    """
    try:
        url = _validate_url(url)
    except ValueError as e:
        return {"crawl_failed": True, "error": str(e), "url": url}

    pages = []
    brand_name = ""

    MIN_GOOD_IMAGES = 20

    def _count_unique_images(page_list):
        seen = set()
        for p in page_list:
            for img in p.get("images", []):
                if _is_quality_image(img):
                    seen.add(img)
        return len(seen)

    def _extract_brand_from_url(target_url: str) -> str:
        parsed = urlparse(target_url)
        hostname = parsed.hostname or ""
        name = hostname.replace("www.", "").split(".")[0]
        return name.title() if name else ""

    blocked_titles = {"just a moment...", "just a moment", "attention required",
                      "access denied", "you have been blocked", "security check"}
    cache_provider_names = {"google", "google search", "google cache", "webcache",
                            "wayback machine", "internet archive", "archive.org",
                            "web archive", "cached", "cache"}

    home_html = ""

    try:
        resp = _fetch_with_retry(HEADERS, url)
        home_html = resp.text

        is_blocked = _is_blocked_page(home_html)

        home_data = _extract_page(home_html, url)
        pages.append(home_data)
        brand_name = home_data["og_site_name"] or home_data["title"].split("|")[0].split("-")[0].strip()

        if brand_name.lower() in blocked_titles or brand_name.lower() in cache_provider_names:
            brand_name = _extract_brand_from_url(url)

        if is_blocked and not home_data["images"] and len(home_data["text"]) < 200:
            logger.warning("[MerchantCrawler] 首页被反爬拦截: %s", url)
            return {
                "crawl_failed": True,
                "partial": True,
                "error": "商家网站触发了反爬保护，无法获取完整内容。AI 将根据 URL 自动生成标题和关键词。",
                "url": url,
                "brand_name": brand_name or _extract_brand_from_url(url),
            }

        home_img_count = _count_unique_images(pages)
        if home_img_count >= MIN_GOOD_IMAGES:
            logger.info("[MerchantCrawler] 首页已有 %d 张图片 (>=%d)，跳过子页面",
                        home_img_count, MIN_GOOD_IMAGES)
        else:
            home_soup = BeautifulSoup(home_html, "lxml")
            sub_urls = _find_sub_pages(home_soup, url)
            logger.info("[MerchantCrawler] 发现 %d 个候选子页面", len(sub_urls))

            INITIAL_BATCH = 3

            # Phase 1: 先爬首批 3 个子页面（不中途检查）
            for i, sub_url in enumerate(sub_urls[:INITIAL_BATCH]):
                try:
                    _time.sleep(_random.uniform(1.0, 2.5))
                    resp = _fetch_with_retry(HEADERS, sub_url, timeout=15)
                    sub_data = _extract_page(resp.text, sub_url)
                    pages.append(sub_data)
                    logger.info("[MerchantCrawler] Phase1 子页面 %d/%d: %s → +%d 图片",
                                i + 1, INITIAL_BATCH, sub_url[:60],
                                len(sub_data.get("images", [])))
                except Exception as e:
                    logger.warning("[MerchantCrawler] Phase1 子页面爬取失败 %s: %s", sub_url, e)

            phase1_count = _count_unique_images(pages)
            logger.info("[MerchantCrawler] Phase1 完成 (首页+%d子页): %d 张图片 (目标 %d)",
                        min(INITIAL_BATCH, len(sub_urls)), phase1_count, MIN_GOOD_IMAGES)

            # Phase 2: 逐页爬取剩余子页面，每爬一页检查一次
            if phase1_count < MIN_GOOD_IMAGES:
                for i, sub_url in enumerate(sub_urls[INITIAL_BATCH:]):
                    current_count = _count_unique_images(pages)
                    if current_count >= MIN_GOOD_IMAGES:
                        logger.info("[MerchantCrawler] Phase2 已达 %d 张图片 (>=%d)，停止",
                                    current_count, MIN_GOOD_IMAGES)
                        break
                    try:
                        _time.sleep(_random.uniform(1.0, 2.5))
                        resp = _fetch_with_retry(HEADERS, sub_url, timeout=15)
                        sub_data = _extract_page(resp.text, sub_url)
                        pages.append(sub_data)
                        new_count = _count_unique_images(pages)
                        logger.info("[MerchantCrawler] Phase2 子页面 %d: %s → 总计 %d 张图片",
                                    INITIAL_BATCH + i + 1, sub_url[:60], new_count)
                    except Exception as e:
                        logger.warning("[MerchantCrawler] Phase2 子页面爬取失败 %s: %s", sub_url, e)

    except httpx.TimeoutException:
        logger.error("[MerchantCrawler] 爬取超时 %s", url)
        if pages:
            logger.info("[MerchantCrawler] 超时但已有 %d 页数据，返回部分结果", len(pages))
        else:
            return {"crawl_failed": True, "error": "商家网站访问超时，该网站可能较慢或服务器无法访问",
                    "url": url, "brand_name": _extract_brand_from_url(url)}
    except httpx.HTTPStatusError as e:
        status = e.response.status_code if e.response else 0
        logger.error("[MerchantCrawler] HTTP %d %s: %s", status, url, e)
        if pages:
            logger.info("[MerchantCrawler] HTTP错误但已有 %d 页数据，返回部分结果", len(pages))
        else:
            if status == 403:
                return {"crawl_failed": True, "partial": True,
                        "error": "商家网站拒绝访问 (403)，AI 将根据 URL 自动生成标题和关键词。",
                        "url": url, "brand_name": _extract_brand_from_url(url)}
            return {"crawl_failed": True, "error": f"商家网站返回 HTTP {status} 错误",
                    "url": url, "brand_name": _extract_brand_from_url(url)}
    except httpx.ConnectError:
        logger.error("[MerchantCrawler] 连接失败 %s", url)
        return {"crawl_failed": True, "error": "无法连接到商家网站，请检查网址是否正确",
                "url": url, "brand_name": _extract_brand_from_url(url)}
    except Exception as e:
        logger.error("[MerchantCrawler] 爬取失败 %s: %s", url, e)
        if pages:
            logger.info("[MerchantCrawler] 异常但已有 %d 页数据，返回部分结果", len(pages))
        else:
            return {"crawl_failed": True, "error": str(e),
                    "url": url, "brand_name": _extract_brand_from_url(url)}

    if not brand_name or brand_name.lower() in cache_provider_names:
        brand_name = _extract_brand_from_url(url)

    # --- 0 图片 / JS渲染站 智能 Playwright 补爬 ---
    total_images = _count_unique_images(pages)
    home_text_len = len(pages[0].get("text", "")) if pages else 0
    need_rescue = False

    if total_images == 0 and pages:
        if home_text_len > 100:
            # 有文字但 0 图 → JS 渲染图片
            need_rescue = True
        elif len(home_html) > 30000:
            # 大 HTML 但 0 文字 0 图 → 纯 SPA 站点（如 viagogo.com）
            need_rescue = True

    if need_rescue:
        platform = _detect_platform(home_html)
        logger.info("[MerchantCrawler] 需要 Playwright 补爬 (imgs=%d, text=%d, html=%dKB, platform=%s)",
                    total_images, home_text_len, len(home_html)//1024, platform)
        pw_resp = _try_playwright(url, timeout=40)
        if pw_resp:
            pw_data = _extract_page(pw_resp.text, url)
            rescue_images = pw_data.get("images", [])
            rescue_text = pw_data.get("text", "")
            if rescue_images:
                pages[0]["images"] = rescue_images
                total_images = len(rescue_images)
            if len(rescue_text) > home_text_len:
                pages[0]["text"] = rescue_text
                # 也更新品牌名和标题（Playwright 渲染后更准）
                if pw_data.get("og_site_name") and pw_data["og_site_name"].lower() not in cache_provider_names:
                    brand_name = pw_data["og_site_name"]
                elif pw_data.get("title") and pw_data["title"].lower() not in blocked_titles and pw_data["title"].split("|")[0].split("-")[0].strip().lower() not in cache_provider_names:
                    brand_name = pw_data["title"].split("|")[0].split("-")[0].strip()
            logger.info("[MerchantCrawler] Playwright 补爬: %d 图片, %d 字文字",
                        len(rescue_images), len(rescue_text))

            # SPA 站点子页面爬取：首页 Playwright 图片不够时，渐进爬取产品子页面
            if total_images < MIN_GOOD_IMAGES:
                pw_soup = BeautifulSoup(pw_resp.text, "lxml")
                spa_sub_urls = _find_sub_pages(pw_soup, url)
                if spa_sub_urls:
                    logger.info("[MerchantCrawler] SPA 子页面补爬: %d 个候选", len(spa_sub_urls))
                    SPA_INITIAL = 3
                    # Phase 1: 先爬 3 个 SPA 子页面
                    for i, sub_url in enumerate(spa_sub_urls[:SPA_INITIAL]):
                        try:
                            _time.sleep(_random.uniform(1.0, 2.0))
                            sub_resp = _try_playwright(sub_url, timeout=25)
                            if sub_resp:
                                sub_data = _extract_page(sub_resp.text, sub_url)
                                if sub_data.get("images"):
                                    pages.append(sub_data)
                                    logger.info("[MerchantCrawler] SPA Phase1 %d/%d %s: +%d 图",
                                                i + 1, SPA_INITIAL, sub_url[:60],
                                                len(sub_data["images"]))
                        except Exception as e:
                            logger.warning("[MerchantCrawler] SPA Phase1 失败 %s: %s", sub_url[:60], e)
                    # Phase 2: 逐页补爬直到满足目标
                    for i, sub_url in enumerate(spa_sub_urls[SPA_INITIAL:]):
                        if _count_unique_images(pages) >= MIN_GOOD_IMAGES:
                            break
                        try:
                            _time.sleep(_random.uniform(1.0, 2.0))
                            sub_resp = _try_playwright(sub_url, timeout=25)
                            if sub_resp:
                                sub_data = _extract_page(sub_resp.text, sub_url)
                                if sub_data.get("images"):
                                    pages.append(sub_data)
                                    logger.info("[MerchantCrawler] SPA Phase2 %d %s: 总计 %d 图",
                                                SPA_INITIAL + i + 1, sub_url[:60],
                                                _count_unique_images(pages))
                        except Exception as e:
                            logger.warning("[MerchantCrawler] SPA Phase2 失败 %s: %s", sub_url[:60], e)
                    total_images = _count_unique_images(pages)

    raw_text = "\n\n".join(
        f"[{p['title']}]\n{p['text']}" for p in pages
    )[:8000]

    total_images = _count_unique_images(pages)
    # 收集所有去重后的高质量图片 URL
    all_quality_images = []
    seen_imgs = set()
    for p in pages:
        for img in p.get("images", []):
            if img not in seen_imgs and _is_quality_image(img):
                seen_imgs.add(img)
                all_quality_images.append(img)

    logger.info(
        "[MerchantCrawler] 爬取完成 %s: %d 页, %d 张高质量图片 (总 %d), brand=%s",
        url, len(pages), len(all_quality_images),
        sum(len(p.get("images", [])) for p in pages), brand_name,
    )

    return {
        "crawl_failed": False,
        "brand_name": brand_name,
        "url": url,
        "pages": pages,
        "raw_text": raw_text,
        "quality_image_count": len(all_quality_images),
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
