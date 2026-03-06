"""
商家网站爬取服务（OPT-012）
httpx + BeautifulSoup 爬取商家首页 + 子页面
"""
import logging
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
]

FILTERED_IMG_KEYWORDS = [
    "icon", "logo", "svg", "pixel", "spacer", "blank", "1x1",
    "badge", "avatar", "favicon", "sprite", "arrow", "btn", "button",
    "social", "facebook", "twitter", "instagram", "linkedin", "youtube",
    "pinterest", "tiktok", "whatsapp", "telegram",
    "payment", "visa", "mastercard", "paypal", "amex", "stripe",
    "trust", "secure", "ssl", "verified", "certification",
    "flag", "rating", "star-rating", "review-star",
    "wsj", "nytimes", "forbes", "cnn", "bbc", "reuters",
    "mens-health", "menshealth", "losangeles", "la-times",
    "myfitnesspal", "beast", "daily", "gazette", "tribune",
    "press", "media", "featured-in", "as-seen", "seen-on",
    "wall-street", "new-york-times", "time-magazine",
]

PRESS_SECTION_KEYWORDS = [
    "press", "media", "featured", "as-seen", "seen-on", "seen-in",
    "trusted", "logo", "logos", "partners", "endorsement",
    "publication", "mentions", "coverage", "recognition",
    "as_seen", "asSeen", "in-the-news", "news-logo",
]

# 产品图优先关键词
PRODUCT_IMG_KEYWORDS = [
    "product", "item", "meal", "food", "dish", "menu",
    "hero", "banner", "feature", "main", "gallery",
    "collection", "shop", "catalog", "lifestyle",
    "photo", "image", "pic", "img-large", "img-full",
]

MIN_IMG_DIMENSION = 200  # 最小宽高像素

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
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
        og_url = og_img["content"]
        og_lower = og_url.lower()
        if not any(kw in og_lower for kw in FILTERED_IMG_KEYWORDS):
            images.append(og_url)

    candidates = []
    for img in soup.find_all("img", src=True)[:60]:
        src = img["src"]
        src_lower = src.lower()
        alt = (img.get("alt") or "").lower()
        combined = src_lower + " " + alt
        if any(kw in combined for kw in FILTERED_IMG_KEYWORDS):
            continue
        full_url = urljoin(url, src)
        if full_url in images:
            continue

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
            ancestor = ancestor.parent

        if is_in_press_section:
            continue

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

    # 按分数排序，取前 10
    candidates.sort(key=lambda x: x[0], reverse=True)
    for _, img_url in candidates:
        if img_url not in images:
            images.append(img_url)
        if len(images) >= 10:
            break

    return {
        "url": url,
        "title": title,
        "meta_description": meta_desc,
        "og_site_name": og_name,
        "text": main_text,
        "images": images,
    }


def _find_sub_pages(soup: BeautifulSoup, base_url: str) -> List[str]:
    """从首页链接中发现关键子页面"""
    parsed_base = urlparse(base_url)
    found = []
    seen = set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        full = urljoin(base_url, href)
        parsed = urlparse(full)
        if parsed.netloc != parsed_base.netloc:
            continue
        path_lower = parsed.path.lower()
        if path_lower in seen or path_lower == "/" or path_lower == parsed_base.path:
            continue
        if any(kw in path_lower for kw in SUB_PAGE_KEYWORDS):
            seen.add(path_lower)
            found.append(full)
            if len(found) >= 3:
                break
    return found


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
        with httpx.Client(timeout=15, follow_redirects=True, headers=HEADERS) as client:
            resp = client.get(url)
            resp.raise_for_status()
            home_html = resp.text

        home_data = _extract_page(home_html, url)
        pages.append(home_data)
        brand_name = home_data["og_site_name"] or home_data["title"].split("|")[0].split("-")[0].strip()

        home_soup = BeautifulSoup(home_html, "lxml")
        sub_urls = _find_sub_pages(home_soup, url)

        for sub_url in sub_urls:
            try:
                with httpx.Client(timeout=10, follow_redirects=True, headers=HEADERS) as client:
                    resp = client.get(sub_url)
                    resp.raise_for_status()
                    sub_data = _extract_page(resp.text, sub_url)
                    pages.append(sub_data)
            except Exception as e:
                logger.warning(f"[MerchantCrawler] 子页面爬取失败 {sub_url}: {e}")

    except Exception as e:
        logger.error(f"[MerchantCrawler] 爬取失败 {url}: {e}")
        return {"crawl_failed": True, "error": str(e), "url": url}

    raw_text = "\n\n".join(
        f"[{p['title']}]\n{p['text']}" for p in pages
    )[:8000]

    return {
        "crawl_failed": False,
        "brand_name": brand_name,
        "url": url,
        "pages": pages,
        "raw_text": raw_text,
    }
