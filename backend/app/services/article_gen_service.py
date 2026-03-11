"""
文章 AI 生成服务（OPT-011/012，移植自 Ediora）
使用 settings.gemini_* 配置，fallback 机制
"""
import json
import logging
import re
import httpx
from datetime import datetime
from typing import List, Dict, Optional

from app.config import settings
from app.services.humanizer_service import humanize

logger = logging.getLogger(__name__)

FAST_MODELS = ["deepseek-chat", "claude-sonnet-4-6", "claude-sonnet-4-20250514"]
SMART_MODELS_FALLBACK = ["deepseek-chat", "claude-sonnet-4-6", "claude-sonnet-4-20250514"]


def _extract_json_text(raw: str) -> str:
    """从 AI 响应中提取纯 JSON 文本，处理 markdown 包裹、前缀描述等"""
    if not raw or not raw.strip():
        return raw
    text = raw.strip()

    # 1) 移除 markdown 代码块: ```json\n...\n``` 或 ```\n...\n```
    if text.startswith("```"):
        # 去掉首行 ```json 或 ```
        first_nl = text.find("\n")
        if first_nl > 0:
            text = text[first_nl + 1:]
        else:
            text = text[3:]
        # 去掉尾部 ```
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
        text = text.strip()

    # 2) 如果已经是 JSON 开头，直接返回
    if text and text[0] in ('{', '['):
        return text

    # 3) 尝试从描述文字中提取 JSON
    for open_ch, close_ch in (('{', '}'), ('[', ']')):
        idx = text.find(open_ch)
        if idx >= 0:
            ridx = text.rfind(close_ch)
            if ridx > idx:
                return text[idx:ridx + 1]

    return text


class ArticleGenService:
    def __init__(self):
        self.api_key = settings.gemini_api_key
        self.base_url = settings.gemini_base_url.rstrip("/")
        self.model = settings.gemini_model  # pro model for analysis
        self.fast_models = FAST_MODELS       # flash models for generation (speed)
        self.fallback_models = SMART_MODELS_FALLBACK

    def _call_api(self, messages: List[Dict], model: str, max_tokens: int = 8192) -> str:
        url = f"{self.base_url}/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": 0.7,
        }
        with httpx.Client(timeout=120) as client:
            resp = client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"]

            if not content or not content.strip():
                raise ValueError(f"模型 {model} 返回空内容")

            return _extract_json_text(content)

    def _call_with_fallback(self, messages: List[Dict], max_tokens: int = 8192, fast: bool = False) -> str:
        if fast:
            models_to_try = self.fast_models
        else:
            # 优先用稳定的 fallback 模型，gemini 放最后（经常返回空）
            models_to_try = self.fallback_models + [self.model]
        # 去重保持顺序
        seen = set()
        unique = []
        for m in models_to_try:
            if m not in seen:
                seen.add(m)
                unique.append(m)
        last_error = None
        for m in unique:
            try:
                logger.info(f"[ArticleGen] 尝试模型: {m}")
                return self._call_api(messages, m, max_tokens)
            except Exception as e:
                last_error = e
                logger.warning(f"[ArticleGen] 模型 {m} 失败: {e}")
        raise last_error

    def generate_titles(self, prompt: str, count: int = 10) -> List[Dict]:
        """AI 生成标题"""
        current_year = datetime.now().year
        system_msg = (
            "You are a JSON API. Respond with ONLY a valid JSON array, no other text.\n"
            f"Generate {count} SEO article titles based on the user's topic. Current year: {current_year}.\n"
            "Each element must have 'title' (Chinese) and 'title_en' (English) fields.\n"
            'Example: [{"title":"中文标题","title_en":"English Title"}]\n'
            "Output the JSON array directly, no markdown, no explanation."
        )
        messages = [
            {"role": "system", "content": system_msg},
            {"role": "user", "content": prompt},
        ]
        raw = self._call_with_fallback(messages, max_tokens=4096)
        try:
            titles = json.loads(raw)
            if isinstance(titles, list):
                return titles[:count]
        except (json.JSONDecodeError, IndexError):
            logger.error(f"[ArticleGen] 标题解析失败: {raw[:200]}")
        return [{"title": f"标题 {i+1}", "title_en": f"Title {i+1}"} for i in range(count)]

    def generate_article(
        self,
        title: str,
        keywords: Optional[List[str]] = None,
        links: Optional[List[Dict]] = None,
        style: str = "informative",
    ) -> Dict:
        """AI 生成文章内容"""
        link_instructions = ""
        if links:
            link_items = [f'- 关键词 "{l["keyword"]}" 链接到 {l["url"]}' for l in links]
            link_instructions = "\n在文章中自然地插入以下超链接：\n" + "\n".join(link_items)

        keyword_instructions = ""
        if keywords:
            keyword_instructions = f"\n请在文章中自然融入以下关键词：{', '.join(keywords)}"

        current_year = datetime.now().year
        system_msg = (
            "You are a JSON API. Respond with ONLY a valid JSON object, no other text.\n"
            f"Generate a high-quality HTML article based on the title. Current year: {current_year}.\n"
            "Article must have h2/h3 subheadings (at least 4 h2 sections), clear paragraphs, rich content (2500-4000 words).\n"
            "Required JSON fields: content (HTML body), excerpt (100-char summary), "
            "meta_title, meta_description, meta_keywords.\n"
            "Output raw JSON only, no markdown code blocks."
        )
        user_msg = f"标题：{title}\n风格：{style}{keyword_instructions}{link_instructions}"

        messages = [
            {"role": "system", "content": system_msg},
            {"role": "user", "content": user_msg},
        ]
        raw = self._call_with_fallback(messages, max_tokens=16384)
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, IndexError):
            logger.error(f"[ArticleGen] 文章解析失败: {raw[:300]}")
            return {
                "content": f"<p>{raw}</p>",
                "excerpt": raw[:100],
                "meta_title": title,
                "meta_description": raw[:160],
                "meta_keywords": title,
            }

    def analyze_merchant(self, crawl_data: Dict, language: str = "zh") -> Dict:
        """分析商家爬取数据，生成标题和关键词建议"""
        current_year = datetime.now().year
        lang_label = {
            'en': '英文', 'zh': '中文', 'de': '德文', 'fr': '法文',
            'es': '西班牙文', 'it': '意大利文', 'pt': '葡萄牙文', 'nl': '荷兰文',
            'pl': '波兰文', 'sv': '瑞典文', 'da': '丹麦文', 'no': '挪威文',
            'fi': '芬兰文', 'ja': '日文', 'ko': '韩文', 'ru': '俄文',
            'tr': '土耳其文', 'th': '泰文', 'vi': '越南文',
        }.get(language, '英文')
        system_prompt = (
            "You are a JSON API. You MUST respond with ONLY a valid JSON object, no other text before or after.\n"
            "Do NOT include any explanation, greeting, or markdown. Output raw JSON only.\n\n"
            f"Analyze the merchant website info below. Current year: {current_year}.\n"
            "Analysis dimensions: products/services, selling points, target audience, promotions, "
            "best article category (fashion/health/home/travel/finance/food/tech/beauty).\n"
            f"Generate 5 promotional article titles and 5 SEO keywords in {lang_label}.\n\n"
            "Required JSON format:\n"
            '{"category":"travel","products":["product1"],"selling_points":["point1"],'
            '"target_audience":"audience","promotions":"promo info",'
            '"titles":[{"title":"中文标题","title_en":"English Title"},{"title":"中文标题2","title_en":"English Title 2"}],'
            '"keywords":["keyword1","keyword2","keyword3","keyword4","keyword5"]}'
        )
        raw_text = crawl_data.get("raw_text", "")
        brand = crawl_data.get("brand_name", "")
        user_msg = f"商家品牌：{brand}\n\n商家网站内容：\n{raw_text[:6000]}"

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_msg},
        ]
        raw = self._call_with_fallback(messages, max_tokens=4096)
        try:
            result = json.loads(raw)
            if not result.get("titles"):
                result["titles"] = [{"title": f"标题 {i+1}", "title_en": f"Title {i+1}"} for i in range(5)]
            if not result.get("keywords"):
                result["keywords"] = [brand] if brand else ["keyword"]
            return result
        except (json.JSONDecodeError, IndexError):
            logger.error(f"[ArticleGen] 商家分析解析失败: {raw[:300]}")
            return {
                "category": "general",
                "products": [],
                "selling_points": [],
                "target_audience": "",
                "promotions": "",
                "titles": [{"title": f"标题 {i+1}", "title_en": f"Title {i+1}"} for i in range(5)],
                "keywords": [brand] if brand else ["keyword"],
            }

    def analyze_url_only(self, url: str, language: str = "zh") -> Dict:
        """仅根据 URL 用 AI 生成标题和关键词（不需要爬虫数据）"""
        from urllib.parse import urlparse
        current_year = datetime.now().year
        parsed = urlparse(url)
        domain = parsed.hostname or url
        brand_guess = domain.replace("www.", "").split(".")[0].capitalize()

        lang_label = {
            'en': '英文', 'zh': '中文', 'de': '德文', 'fr': '法文',
            'es': '西班牙文', 'it': '意大利文', 'pt': '葡萄牙文', 'nl': '荷兰文',
            'pl': '波兰文', 'sv': '瑞典文', 'da': '丹麦文', 'no': '挪威文',
            'fi': '芬兰文', 'ja': '日文', 'ko': '韩文', 'ru': '俄文',
            'tr': '土耳其文', 'th': '泰文', 'vi': '越南文',
        }.get(language, '英文')

        system_prompt = (
            "You are a JSON API. You MUST respond with ONLY a valid JSON object, no other text.\n"
            "Do NOT include any explanation, greeting, or markdown. Output raw JSON only.\n\n"
            f"Based on the merchant website URL below, generate promotional content. Current year: {current_year}.\n"
            "Even though you cannot access the website, use the domain name and URL path to infer:\n"
            "- What kind of products/services they likely offer\n"
            "- Their brand positioning\n"
            "- Target audience\n\n"
            f"Generate 5 promotional article titles and 5 SEO keywords in {lang_label}.\n"
            "Titles should be engaging, SEO-friendly, and suitable for affiliate marketing.\n\n"
            "Required JSON format:\n"
            '{"brand_name":"BrandName","category":"travel","products":["product1"],'
            '"selling_points":["point1"],"target_audience":"audience","promotions":"",'
            '"titles":[{"title":"标题","title_en":"English Title"}],'
            '"keywords":["keyword1","keyword2","keyword3","keyword4","keyword5"]}'
        )
        user_msg = f"商家网站 URL：{url}\n域名：{domain}\n推测品牌名：{brand_guess}"

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_msg},
        ]
        raw = self._call_with_fallback(messages, max_tokens=4096)
        try:
            result = json.loads(raw)
            if not result.get("titles"):
                result["titles"] = [{"title": f"{brand_guess} 推荐 {i+1}", "title_en": f"{brand_guess} Recommendation {i+1}"} for i in range(5)]
            if not result.get("keywords"):
                result["keywords"] = [brand_guess, "shopping", "deals", "review", "best"]
            if not result.get("brand_name"):
                result["brand_name"] = brand_guess
            return result
        except (json.JSONDecodeError, IndexError):
            logger.error(f"[ArticleGen] URL分析解析失败: {raw[:300]}")
            return {
                "brand_name": brand_guess,
                "category": "general",
                "products": [],
                "selling_points": [],
                "target_audience": "",
                "promotions": "",
                "titles": [{"title": f"{brand_guess} 推荐 {i+1}", "title_en": f"{brand_guess} Recommendation {i+1}"} for i in range(5)],
                "keywords": [brand_guess, "shopping", "deals", "review", "best"],
            }

    def generate_merchant_article(
        self,
        title: str,
        merchant_info: Dict,
        tracking_link: str,
        keywords: Optional[List[str]] = None,
        language: str = "zh",
    ) -> Dict:
        """
        商家推广文章生成（OPT-012）
        融合露出提示词规则：软植入、编辑视角、10-15个超链接、去AI味
        """
        current_year = datetime.now().year
        brand = merchant_info.get("brand_name", "品牌")
        products_list = merchant_info.get("products", [])[:5]
        products = ", ".join(products_list)
        selling_points = ", ".join(merchant_info.get("selling_points", [])[:5])
        promotions = merchant_info.get("promotions", "")
        lang_label = {
            'en': 'English', 'zh': '中文', 'de': 'German', 'fr': 'French',
            'es': 'Spanish', 'it': 'Italian', 'pt': 'Portuguese', 'nl': 'Dutch',
            'pl': 'Polish', 'sv': 'Swedish', 'da': 'Danish', 'no': 'Norwegian',
            'fi': 'Finnish', 'ja': 'Japanese', 'ko': 'Korean', 'ru': 'Russian',
            'tr': 'Turkish', 'th': 'Thai', 'vi': 'Vietnamese', 'id': 'Indonesian',
            'hi': 'Hindi', 'ar': 'Arabic', 'cs': 'Czech', 'sk': 'Slovak',
            'hu': 'Hungarian', 'ro': 'Romanian', 'bg': 'Bulgarian', 'hr': 'Croatian',
            'el': 'Greek', 'he': 'Hebrew',
        }.get(language, language)

        # 构建链接词列表：品牌名 + 产品名 + 关键词 → 都要做超链接
        link_words = [brand]
        for p in products_list:
            if p and p.lower() != brand.lower():
                link_words.append(p)
        if keywords:
            for kw in keywords:
                if kw and kw.lower() not in [w.lower() for w in link_words]:
                    link_words.append(kw)
        link_examples = ", ".join(
            f'<a href="{tracking_link}">{w}</a>' for w in link_words[:6]
        )

        system_prompt = (
            f"You are an experienced lifestyle content editor writing a soft-promotion article in {lang_label}. Year: {current_year}.\n\n"
            "【Core Principles — MUST follow】\n"
            "1. AUTHENTICITY FIRST: Write like a real human editor, NOT an AI. Use personal anecdotes, "
            "first-person perspective, casual observations, and genuine opinions. Imagine you are recommending "
            "something to a friend over coffee.\n"
            "2. SOFT PLACEMENT: The brand should be woven in naturally — like a friend mentioning a product "
            "they genuinely like. NEVER open the article with the brand name. The brand should NOT appear "
            "in the first paragraph at all. Introduce it casually mid-article.\n"
            "3. FACTUAL ACCURACY: Product names, features, and prices must match the merchant website.\n"
            "4. NO HARD SELL: No advertising tone, no hype, no pressure language.\n\n"
            "【BANNED words/phrases — NEVER use these】\n"
            "revolutionizing, game-changer, elevate, seamlessly, cutting-edge, delve, comprehensive, "
            "landscape, foster, leverage, harness, robust, streamline, empower, curated, innovative, "
            "transformative, groundbreaking, it is worth noting, in today's world, without a doubt, "
            "needless to say, in conclusion, to sum up, furthermore, moreover, incredibly, absolutely, "
            "undoubtedly, embark, navigate, realm, pivotal, testament, beacon, tapestry, multifaceted, "
            "holistic, synergy, paradigm, ecosystem\n\n"
            f"【Link Rules — CRITICAL】\n"
            f"Tracking link (use this for ALL hyperlinks): {tracking_link}\n"
            "Link method:\n"
            f"- Brand name link: use brand name as anchor text → <a href=\"{tracking_link}\">{brand}</a>\n"
            "- Product name link: use product name as anchor text\n"
            "- Category/keyword link: use the keyword as anchor text\n"
            f"- Examples: {link_examples}\n"
            "- TOTAL hyperlinks in the article: 10-15 (spread evenly across the article, not clustered)\n"
            "- Every mention of the brand name, product names, and related keywords should be hyperlinked\n"
            "- All links point to the SAME tracking URL above\n\n"
            "【Article Requirements】\n"
            f"- Length: 800-1200 words (medium length)\n"
            f"- Language: {lang_label}\n"
            "- Category: judge based on the merchant's business (fashion/health/home/travel/finance/food/beauty/tech/lifestyle)\n"
            "- Structure: HTML with h2 headings, 4-6 sections, use <p> tags\n"
            "- Writing style: editor perspective, personal stories, conversational language, genuine views\n"
            "- DO NOT start with the brand. Start with a relatable scenario, personal experience, or observation.\n"
            "- DO NOT use consecutive paragraphs that all mention the brand.\n\n"
            "CRITICAL: Output ONLY raw JSON, no markdown, no explanation, no preamble. "
            "Do NOT say 'I will write' or 'Let me create'. Start directly with {.\n"
            "JSON schema: "
            "{\"content\":\"<full article HTML with h2/h3/p tags, 10-15 hyperlinks>\","
            "\"excerpt\":\"100-char plain text summary\","
            "\"meta_title\":\"SEO title\","
            "\"meta_description\":\"160-char description\","
            "\"meta_keywords\":\"comma separated\","
            "\"category\":\"one of: health,tech,lifestyle,fashion,beauty,fitness,food,travel,finance,general\","
            "\"author\":\"a realistic pen name matching the article language\"}"
        )

        keyword_str = ""
        if keywords:
            keyword_str = f"\nSEO keywords (weave naturally): {', '.join(keywords)}"

        user_msg = (
            f"Title: {title}\nBrand: {brand}\nProducts: {products}\n"
            f"Selling points: {selling_points}\nPromo: {promotions}\n"
            f"Link: {tracking_link}{keyword_str}"
        )

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_msg},
        ]
        raw = self._call_with_fallback(messages, max_tokens=16384, fast=True)
        result = self._robust_parse_json(raw, title)

        if result.get("content"):
            result["content"] = humanize(result["content"])
            # 链接后处理：确保 10-15 个超链接
            result["content"] = self._ensure_link_count(
                result["content"], tracking_link, brand, products_list, keywords or []
            )

        return result

    def _ensure_link_count(
        self, content: str, tracking_link: str, brand: str,
        products: List[str], keywords: List[str],
        min_links: int = 10, max_links: int = 15,
    ) -> str:
        """后处理：确保文章中超链接数量在 min_links ~ max_links 之间"""
        import re as _re

        # 统计现有链接
        existing = list(_re.finditer(r'<a\s+[^>]*href=["\'][^"\']*["\'][^>]*>([^<]+)</a>', content))
        count = len(existing)
        logger.info("[LinkPostProcess] 当前链接数: %d (目标: %d-%d)", count, min_links, max_links)

        # 如果链接不足，补充
        if count < min_links:
            # 构建要链接的词列表（按优先级）
            link_candidates = []
            if brand:
                link_candidates.append(brand)
            for p in products:
                if p and p not in link_candidates:
                    link_candidates.append(p)
            for kw in keywords:
                if kw and kw not in link_candidates:
                    link_candidates.append(kw)

            # 已经被链接的文本（避免重复）
            linked_texts = set()
            for m in existing:
                linked_texts.add(m.group(1).lower())

            needed = min_links - count
            added = 0
            for word in link_candidates:
                if added >= needed:
                    break
                # 查找文章中未被链接的该词出现位置
                # 用 word boundary 匹配，忽略已在 <a> 标签内的
                pattern = _re.compile(
                    r'(?<!</a>)(?<!["\'>])(?<!href=["\'])(\b' + _re.escape(word) + r'\b)(?![^<]*</a>)',
                    _re.IGNORECASE
                )
                matches = list(pattern.finditer(content))
                for m in matches:
                    if added >= needed:
                        break
                    # 确保不在已有的 <a> 标签内
                    before = content[max(0, m.start()-50):m.start()]
                    if '<a ' in before and '</a>' not in before:
                        continue
                    replacement = f'<a href="{tracking_link}">{m.group(1)}</a>'
                    content = content[:m.start()] + replacement + content[m.end():]
                    added += 1
                    # 重新计算后续匹配位置（因为内容长度变了）
                    break  # 每个词每轮只替换一个，下轮继续

            # 如果还不够，再循环一轮
            if added < needed:
                for word in link_candidates:
                    if added >= needed:
                        break
                    pattern = _re.compile(
                        r'(?<!</a>)(?<!["\'>])(\b' + _re.escape(word) + r'\b)(?![^<]*</a>)',
                        _re.IGNORECASE
                    )
                    for m in pattern.finditer(content):
                        before = content[max(0, m.start()-50):m.start()]
                        if '<a ' in before and '</a>' not in before:
                            continue
                        replacement = f'<a href="{tracking_link}">{m.group(1)}</a>'
                        content = content[:m.start()] + replacement + content[m.end():]
                        added += 1
                        break

            logger.info("[LinkPostProcess] 补充了 %d 个链接", added)

        # 如果链接过多，移除多余的（从后往前移除，保留前面的）
        elif count > max_links:
            existing_reversed = list(reversed(existing))
            to_remove = count - max_links
            removed = 0
            for m in existing_reversed:
                if removed >= to_remove:
                    break
                # 保留原文本，去掉 <a> 标签
                full_match = m.group(0)
                inner_text = m.group(1)
                content = content.replace(full_match, inner_text, 1)
                removed += 1
            logger.info("[LinkPostProcess] 移除了 %d 个多余链接", removed)

        return content

    def generate_images(self, title: str, count: int = 5) -> List[Dict]:
        """生成配图建议（返回图片搜索关键词 + Unsplash URL）"""
        system_msg = (
            f"根据文章标题，生成 {count} 个适合作为文章配图的搜索关键词。"
            "以 JSON 数组返回，每个元素包含 keyword（英文搜索词）和 url（Unsplash 搜索链接）。"
            "url 格式：https://unsplash.com/s/photos/{keyword}"
            "\n只返回 JSON 数组。"
        )
        messages = [
            {"role": "system", "content": system_msg},
            {"role": "user", "content": f"文章标题：{title}"},
        ]
        raw = self._call_with_fallback(messages, max_tokens=2048)
        try:
            text = raw.strip()
            if text.startswith("```"):
                text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            result = json.loads(text)
            if isinstance(result, list):
                return result[:count]
        except (json.JSONDecodeError, IndexError):
            logger.error(f"[ArticleGen] 配图解析失败: {raw[:200]}")
        return [
            {"keyword": f"image-{i+1}", "url": f"https://unsplash.com/s/photos/article"}
            for i in range(count)
        ]

    def _robust_parse_json(self, raw: str, title: str) -> dict:
        """增强的 JSON 解析，多层容错。"""
        text = raw.strip()

        # 1. 去掉 markdown 代码块
        if text.startswith("```"):
            text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

        # 2. 直接解析
        try:
            result = json.loads(text)
            if isinstance(result, dict) and result.get("content"):
                result["content"] = self._clean_content(result["content"])
                return result
        except (json.JSONDecodeError, IndexError):
            pass

        # 3. 正则提取第一个 JSON 对象 { ... }
        match = re.search(r'\{[\s\S]*\}', text)
        if match:
            try:
                result = json.loads(match.group())
                if isinstance(result, dict) and result.get("content"):
                    result["content"] = self._clean_content(result["content"])
                    return result
            except (json.JSONDecodeError, IndexError):
                pass

        # 4. 尝试修复截断的 JSON（AI 输出被 max_tokens 截断）
        if '"content"' in text:
            # 方案A: 用更宽松的正则提取 content（处理 HTML 中的引号）
            # 找到 "content": " 的起始位置，然后向后找到下一个 JSON 字段或结尾
            cm = re.search(r'"content"\s*:\s*"', text)
            if cm:
                start = cm.end()
                # 从 start 开始，找到 content 值的结尾
                # 策略：找下一个 JSON 字段 ,"field": 或 JSON 结尾 }
                end_patterns = [
                    r'",\s*"excerpt"',
                    r'",\s*"meta_title"',
                    r'",\s*"meta_description"',
                    r'",\s*"meta_keywords"',
                    r'",\s*"category"',
                    r'",\s*"author"',
                    r'"\s*\}',
                ]
                end_pos = len(text)
                for ep in end_patterns:
                    em = re.search(ep, text[start:])
                    if em and (start + em.start()) < end_pos:
                        end_pos = start + em.start()

                content = text[start:end_pos]
                # 清理 JSON 转义
                content = content.replace("\\n", "\n").replace("\\t", "\t")
                content = content.replace('\\"', '"').replace("\\/", "/")
                content = self._clean_content(content)

                if len(content) > 100:
                    logger.warning("[ArticleGen] JSON 截断，从 content 字段提取 HTML (%d chars)", len(content))
                    # 尝试提取其他字段
                    excerpt = ""
                    em2 = re.search(r'"excerpt"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
                    if em2:
                        excerpt = em2.group(1).replace("\\n", " ").replace('\\"', '"')
                    category = "general"
                    catm = re.search(r'"category"\s*:\s*"([^"]*)"', text)
                    if catm:
                        category = catm.group(1)
                    author = ""
                    am = re.search(r'"author"\s*:\s*"([^"]*)"', text)
                    if am:
                        author = am.group(1)
                    meta_title = title
                    mtm = re.search(r'"meta_title"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
                    if mtm:
                        meta_title = mtm.group(1).replace('\\"', '"')
                    meta_desc = ""
                    mdm = re.search(r'"meta_description"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
                    if mdm:
                        meta_desc = mdm.group(1).replace('\\"', '"')
                    meta_kw = title
                    mkm = re.search(r'"meta_keywords"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
                    if mkm:
                        meta_kw = mkm.group(1).replace('\\"', '"')
                    return {
                        "content": content,
                        "excerpt": excerpt or re.sub(r'<[^>]+>', '', content)[:150],
                        "meta_title": meta_title,
                        "meta_description": meta_desc or re.sub(r'<[^>]+>', '', content)[:160],
                        "meta_keywords": meta_kw,
                        "category": category,
                        "author": author,
                    }

        # 5. 如果文本本身包含 HTML 标签，直接当 content 用
        if "<h2" in text or "<p>" in text:
            content = text
            # 清理可能的 JSON 包裹残留
            content = re.sub(r'^[^<]*(?=<)', '', content)  # 去掉 HTML 前的非标签内容
            content = self._clean_content(content)
            logger.warning("[ArticleGen] JSON 解析失败，从原始文本提取 HTML content")
            return {
                "content": content,
                "excerpt": re.sub(r'<[^>]+>', '', content)[:150],
                "meta_title": title,
                "meta_description": re.sub(r'<[^>]+>', '', content)[:160],
                "meta_keywords": title,
                "category": "general",
            }

        # 6. 最终 fallback
        logger.error(f"[ArticleGen] 商家文章解析完全失败: {raw[:300]}")
        return {
            "content": f"<p>{text}</p>",
            "excerpt": re.sub(r'<[^>]+>', '', text)[:150],
            "meta_title": title,
            "meta_description": text[:160],
            "meta_keywords": title,
            "category": "general",
        }

    @staticmethod
    def _clean_content(html: str) -> str:
        """清洗 AI 生成的 HTML content，确保无乱码/转义残留。"""
        if not html:
            return html
        # 处理 JSON 转义残留（多轮清理确保彻底）
        html = html.replace("\\n", "\n").replace("\\t", "\t")
        html = html.replace('\\"', '"').replace("\\/", "/")
        # 再次处理可能的双重转义
        html = html.replace("\\n", "\n").replace("\\t", "\t")
        # 去掉字面 \n 文本（非真正换行，显示为 \n 的字符串）
        html = re.sub(r'(?<!\\)\\n', '\n', html)
        # 去掉连续多余空行
        html = re.sub(r'\n{3,}', '\n\n', html)
        # 去掉 JSON 包裹残留
        html = re.sub(r'^\s*\{\s*"content"\s*:\s*"?', '', html)
        html = re.sub(r'"?\s*\}\s*$', '', html)
        # 去掉开头的非 HTML 内容（如 JSON 字段名残留）
        if re.search(r'<[a-zA-Z]', html):
            html = re.sub(r'^[^<]*?(?=<[a-zA-Z])', '', html, count=1)
        # 去掉结尾的 JSON 字段残留
        html = re.sub(r',?\s*"(excerpt|meta_title|meta_description|meta_keywords|category|author)"\s*:.*$', '', html, flags=re.DOTALL)
        return html.strip()
