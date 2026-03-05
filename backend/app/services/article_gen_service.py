"""
文章 AI 生成服务（OPT-011，移植自 Ediora）
使用 settings.gemini_* 配置，fallback 机制
"""
import json
import logging
import httpx
from typing import List, Dict, Optional

from app.config import settings

logger = logging.getLogger(__name__)

FALLBACK_MODELS = ["gemini-1.5-flash", "gemini-1.5-pro"]


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
        system_msg = (
            "你是一个专业的 SEO 文案写手。根据用户提供的主题，生成吸引人的文章标题。"
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

        system_msg = (
            "你是一个专业的内容创作者。请根据标题生成一篇高质量的 HTML 文章。"
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
