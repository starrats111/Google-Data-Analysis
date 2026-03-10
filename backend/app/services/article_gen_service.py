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
            "Article must have h2/h3 subheadings, clear paragraphs, rich content (1500+ words).\n"
            "Required JSON fields: content (HTML body), excerpt (100-char summary), "
            "meta_title, meta_description, meta_keywords.\n"
            "Output raw JSON only, no markdown code blocks."
        )
        user_msg = f"标题：{title}\n风格：{style}{keyword_instructions}{link_instructions}"

        messages = [
            {"role": "system", "content": system_msg},
            {"role": "user", "content": user_msg},
        ]
        raw = self._call_with_fallback(messages, max_tokens=8192)
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
        融合07提供的露出提示词规则 + 自动去AI味
        """
        current_year = datetime.now().year
        brand = merchant_info.get("brand_name", "品牌")
        products = ", ".join(merchant_info.get("products", [])[:5])
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

        keyword_str = ""
        keyword_link_rule = ""
        if keywords:
            keyword_str = f"\nSEO 关键词（自然融入）：{', '.join(keywords)}"
            kw_examples = ", ".join(f'<a href="{tracking_link}">{kw}</a>' for kw in keywords[:3])
            keyword_link_rule = (
                f"7)Each SEO keyword should be hyperlinked to {tracking_link} "
                f"on its FIRST occurrence, e.g. {kw_examples}\n"
            )

        system_prompt = (
            f"You are a lifestyle editor writing in {lang_label}. Year: {current_year}.\n"
            "Rules: 1)No AI buzzwords(revolutionizing,game-changer,elevate,seamlessly,cutting-edge) "
            "2)Brand name appears 3-4 times, NOT in first paragraph "
            f"3)Insert 2-3 brand links: <a href=\"{tracking_link}\">{brand}</a> "
            "4)Write like a real editor with personal tone "
            "5)800-1200 words, HTML with h2/h3 "
            "6)No empty praise, be specific\n"
            f"{keyword_link_rule}"
            "CRITICAL: Output ONLY raw JSON, no markdown, no explanation, no preamble. "
            "Do NOT say 'I will write' or 'Let me create'. Start directly with {. "
            "JSON schema: "
            "{\"content\":\"<full article HTML with h2/h3/p tags>\","
            "\"excerpt\":\"100-char plain text summary\","
            "\"meta_title\":\"SEO title\","
            "\"meta_description\":\"160-char description\","
            "\"meta_keywords\":\"comma separated\","
            "\"category\":\"one of: health,tech,lifestyle,fashion,beauty,fitness,food,travel,finance,general\","
            "\"author\":\"a realistic pen name matching the article language\"}"
        )

        user_msg = (
            f"Title: {title}\nBrand: {brand}\nProducts: {products}\n"
            f"Selling points: {selling_points}\nPromo: {promotions}\n"
            f"Link: {tracking_link}{keyword_str}"
        )

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_msg},
        ]
        raw = self._call_with_fallback(messages, max_tokens=8192, fast=True)
        result = self._robust_parse_json(raw, title)

        if result.get("content"):
            result["content"] = humanize(result["content"])

        return result

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
