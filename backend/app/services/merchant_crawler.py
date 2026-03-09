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
]

PRESS_SECTION_KEYWORDS = [
    "press-logo", "media-logo", "as-seen", "seen-on", "seen-in",
    "trusted-by-logo", "partner-logo", "endorsement",
    "publication-logo", "as_seen", "asSeen", "in-the-news",
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
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
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

    candidates = []
    seen_urls = set(images)

    def _get_img_src(tag):
        """从 img/source 标签中提取最佳图片 URL（支持懒加载和 srcset）"""
        for attr in ("src", "data-src", "data-lazy-src", "data-original", "data-srcset"):
            val = tag.get(attr)
            if val and val.startswith(("http", "/")):
                return val
        srcset = tag.get("srcset")
        if srcset:
            parts = [p.strip().split()[0] for p in srcset.split(",") if p.strip()]
            if parts:
                return parts[-1]  # 取最大尺寸
        return None

    # 收集所有 <img> 和 <picture><source> 的图片
    all_img_tags = soup.find_all("img")[:80]
    for source in soup.find_all("source"):
        if source.get("srcset") or source.get("data-srcset"):
            all_img_tags.append(source)

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

    candidates.sort(key=lambda x: x[0], reverse=True)
    for _, img_url in candidates:
        if img_url not in images:
            images.append(img_url)
        if len(images) >= 30:
            break

    images = _deduplicate_cdn_images(images)

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
            if len(found) >= 8:
                break
    return found


_FALLBACK_UAS = [
    (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    (
        "Mozilla/5.0 (X11; Linux x86_64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/123.0.0.0 Safari/537.36"
    ),
]


def _fetch_with_retry(client_headers: Dict, url: str, timeout: int = 20) -> httpx.Response:
    """
    尝试用主 headers 请求；若遇 403 则换 User-Agent 重试。
    """
    import copy, time
    headers = copy.copy(client_headers)
    attempts = [headers["User-Agent"]] + _FALLBACK_UAS
    last_resp = None
    for ua in attempts:
        headers["User-Agent"] = ua
        with httpx.Client(timeout=timeout, follow_redirects=True, headers=headers) as client:
            resp = client.get(url)
            if resp.status_code != 403:
                resp.raise_for_status()
                return resp
            last_resp = resp
            time.sleep(0.5)
    # 所有 UA 都 403，抛出
    if last_resp is not None:
        last_resp.raise_for_status()
    raise httpx.HTTPStatusError("403 Forbidden", request=httpx.Request("GET", url), response=last_resp)


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

        for sub_url in sub_urls[:3]:
            try:
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

    return {
        "crawl_failed": False,
        "brand_name": brand_name,
        "url": url,
        "pages": pages,
        "raw_text": raw_text,
    }


def search_images(query: str, count: int = 12) -> List[str]:
    """
    搜索可商用的图片作为补充。
    优先使用 Pexels API（免费可商用），fallback 到 Unsplash URL 拼接。
    所有返回图片均可免费商用，无需署名。
    """
    from app.config import settings

    images = []

    # ===== 方案1: Pexels API（推荐，高质量可商用）=====
    pexels_key = getattr(settings, "PEXELS_API_KEY", "")
    if pexels_key:
        try:
            with httpx.Client(timeout=15, follow_redirects=True) as client:
                resp = client.get(
                    "https://api.pexels.com/v1/search",
                    params={"query": query, "per_page": min(count * 2, 40), "size": "large"},
                    headers={"Authorization": pexels_key},
                )
                resp.raise_for_status()
                data = resp.json()
                for photo in data.get("photos", []):
                    # 使用 large2x 尺寸（高清但不过大）
                    src = photo.get("src", {})
                    url = src.get("large2x") or src.get("large") or src.get("original")
                    if url and url not in images:
                        images.append(url)
            logger.info(f"[ImageSearch] Pexels 搜索 '{query}' 找到 {len(images)} 张可商用图片")
        except Exception as e:
            logger.warning(f"[ImageSearch] Pexels 搜索失败 '{query}': {e}")

    # ===== 方案2: Unsplash Source URL 拼接（免费可商用，无需 API Key）=====
    if len(images) < count:
        try:
            # Unsplash 搜索页面抓取（所有图片均为 Unsplash License，可免费商用）
            with httpx.Client(timeout=15, follow_redirects=True, headers=HEADERS) as client:
                resp = client.get(
                    "https://unsplash.com/napi/search/photos",
                    params={"query": query, "per_page": min(count * 2, 30)},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    for result in data.get("results", []):
                        urls = result.get("urls", {})
                        url = urls.get("regular") or urls.get("small")
                        if url and url not in images:
                            images.append(url)
                    logger.info(f"[ImageSearch] Unsplash 补充后共 {len(images)} 张可商用图片")
        except Exception as e:
            logger.warning(f"[ImageSearch] Unsplash 搜索失败 '{query}': {e}")

    # 去重并截取
    seen = set()
    unique = []
    for img in images:
        if img not in seen:
            seen.add(img)
            unique.append(img)
        if len(unique) >= count:
            break

    return unique
