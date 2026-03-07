"""
文章 AI 生成服务（OPT-011/012，移植自 Ediora）
使用 settings.gemini_* 配置，fallback 机制
"""
import json
import logging
import httpx
from datetime import datetime
from typing import List, Dict, Optional

from app.config import settings
from app.services.humanizer_service import humanize

logger = logging.getLogger(__name__)

FALLBACK_MODELS = ["[福利]gemini-3-flash-preview-thinking", "[福利]gemini-2.5-flash-lite"]


class ArticleGenService:
    def __init__(self):
        self.api_key = settings.gemini_api_key
        self.base_url = settings.gemini_base_url.rstrip("/")
        self.model = settings.gemini_model
        self.fallback_models = FALLBACK_MODELS

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
            return data["choices"][0]["message"]["content"]

    def _call_with_fallback(self, messages: List[Dict], max_tokens: int = 8192) -> str:
        models_to_try = [self.model] + self.fallback_models
        last_error = None
        for m in models_to_try:
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
            "你是一个专业的 SEO 文案写手。根据用户提供的主题，生成吸引人的文章标题。"
            f"当前年份是 {current_year} 年，标题中如果涉及年份必须使用 {current_year}，不要使用过去的年份。"
            f"请生成 {count} 个标题，以 JSON 数组格式返回，每个元素包含 title（中文）和 title_en（英文）字段。"
            "只返回 JSON 数组，不要其他内容。"
        )
        messages = [
            {"role": "system", "content": system_msg},
            {"role": "user", "content": prompt},
        ]
        raw = self._call_with_fallback(messages, max_tokens=4096)
        try:
            text = raw.strip()
            if text.startswith("```"):
                text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            titles = json.loads(text)
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
            "你是一个专业的内容创作者。请根据标题生成一篇高质量的 HTML 文章。"
            f"当前年份是 {current_year} 年，文章内容中涉及年份必须使用 {current_year}。"
            "文章需要包含适当的 h2/h3 子标题结构，段落清晰，内容丰富（至少 1500 字）。"
            "以 JSON 格式返回，包含 content（HTML 正文）、excerpt（100字摘要）、meta_title、meta_description、meta_keywords 字段。"
            "只返回 JSON 对象，不要 markdown 代码块。"
        )
        user_msg = f"标题：{title}\n风格：{style}{keyword_instructions}{link_instructions}"

        messages = [
            {"role": "system", "content": system_msg},
            {"role": "user", "content": user_msg},
        ]
        raw = self._call_with_fallback(messages, max_tokens=8192)
        try:
            text = raw.strip()
            if text.startswith("```"):
                text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            return json.loads(text)
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
        lang_label = "英文" if language == "en" else "中文"
        system_prompt = (
            f"你是一位资深内容策划师。分析以下商家网站信息，返回 JSON 格式结果。"
            f"当前年份是 {current_year}。\n\n"
            "分析维度：\n"
            "1. 主营产品/服务类型\n"
            "2. 核心卖点和特色\n"
            "3. 目标受众群体\n"
            "4. 当前促销活动或热门产品\n"
            "5. 最适合的文章分类（fashion/health/home/travel/finance/food/tech/beauty）\n\n"
            "然后根据分析结果，生成 5 个适合软文推广的文章标题和 5 个 SEO 关键词。\n\n"
            f"输出语言：{lang_label}\n\n"
            "仅返回 JSON，格式如下：\n"
            '{"category":"travel","products":["产品1"],"selling_points":["卖点1"],'
            '"target_audience":"目标受众","promotions":"促销信息",'
            '"titles":[{"title":"中文标题","title_en":"English Title"}],'
            '"keywords":["keyword1","keyword2"]}'
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
            text = raw.strip()
            if text.startswith("```"):
                text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            result = json.loads(text)
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
        lang_label = "English" if language == "en" else "中文"

        keyword_str = ""
        if keywords:
            keyword_str = f"\nSEO 关键词（自然融入）：{', '.join(keywords)}"

        system_prompt = (
            f"你是一位真人编辑，正在为一个生活方式网站撰写文章。当前年份是 {current_year}。\n\n"
            "===== 写作铁律 =====\n"
            "1. 真实感第一：禁用以下词汇 —— revolutionizing, game-changer, elevate, seamlessly, "
            "cutting-edge, groundbreaking, transformative, 此外, 充满活力, 至关重要, 值得注意的是, 综上所述\n"
            "2. 软植入：品牌关键词在全文出现 3~4 次，不得在开头第一段提及品牌名\n"
            f"3. 链接植入：追踪链接以品牌名或产品名为锚文本，自然嵌入 <a href=\"{tracking_link}\">{brand}</a>，共 2~3 处\n"
            "4. 编辑视角：像真人编辑撰写，可用个人故事、生活化语言、具体细节\n"
            "5. 篇幅：800~1200 字\n"
            "6. 结构：HTML 格式，含 h2/h3 子标题，段落清晰\n"
            f"7. 语言：{lang_label}\n"
            "8. 禁止空泛赞美，所有描述必须有具体依据\n"
            "9. 文章应该像是一篇真正的编辑推荐文章，而不是广告\n\n"
            "===== 输出格式 =====\n"
            "仅返回 JSON 对象，包含以下字段：\n"
            "content（HTML 正文）、excerpt（100字摘要）、meta_title、meta_description、meta_keywords、category\n"
            "不要 markdown 代码块包裹。"
        )

        user_msg = (
            f"文章标题：{title}\n"
            f"品牌名：{brand}\n"
            f"主营产品：{products}\n"
            f"核心卖点：{selling_points}\n"
            f"当前促销：{promotions}\n"
            f"追踪链接：{tracking_link}"
            f"{keyword_str}"
        )

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_msg},
        ]
        raw = self._call_with_fallback(messages, max_tokens=8192)
        try:
            text = raw.strip()
            if text.startswith("```"):
                text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            result = json.loads(text)
        except (json.JSONDecodeError, IndexError):
            logger.error(f"[ArticleGen] 商家文章解析失败: {raw[:300]}")
            result = {
                "content": f"<p>{raw}</p>",
                "excerpt": raw[:100],
                "meta_title": title,
                "meta_description": raw[:160],
                "meta_keywords": title,
                "category": "general",
            }

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
