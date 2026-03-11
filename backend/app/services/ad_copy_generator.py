"""
AI 广告素材生成服务（CR-039）
使用 Claude/DeepSeek 生成 Google RSA 广告的标题和描述。
"""
import json
import logging
from typing import Dict, List, Optional

from app.services.article_gen_service import ArticleGenService

logger = logging.getLogger(__name__)

# RSA 广告限制
RSA_HEADLINE_MAX = 30  # 标题最大字符数
RSA_HEADLINE_COUNT = 15  # 最多 15 个标题
RSA_DESC_MAX = 90  # 描述最大字符数
RSA_DESC_COUNT = 4  # 最多 4 个描述


class AdCopyGenerator:
    """AI 广告文案生成器"""

    def __init__(self):
        self.gen_service = ArticleGenService()

    def generate_ad_copy(
        self,
        merchant_name: str,
        merchant_url: str,
        keywords: List[Dict],
        category: str = "",
        language: str = "en",
    ) -> Dict:
        """生成 RSA 广告素材（标题 + 描述）。

        返回:
        {
            "headlines": ["标题1", "标题2", ...],  # 最多 15 个，每个 ≤ 30 字符
            "descriptions": ["描述1", "描述2", ...],  # 最多 4 个，每个 ≤ 90 字符
        }
        """
        top_keywords = [kw["keyword"] for kw in keywords[:10]]
        kw_text = ", ".join(top_keywords) if top_keywords else merchant_name

        prompt = f"""You are a Google Ads expert. Generate RSA (Responsive Search Ad) copy for this merchant:

Merchant: {merchant_name}
Website: {merchant_url}
Category: {category or 'General'}
Top Keywords: {kw_text}
Language: {language}

Requirements:
1. Generate exactly 15 headlines (each MUST be ≤ 30 characters)
2. Generate exactly 4 descriptions (each MUST be ≤ 90 characters)
3. Headlines should include:
   - Brand name variations
   - Key product/service mentions
   - Call-to-action phrases (Shop Now, Get Started, etc.)
   - Keyword-rich headlines using the top keywords
4. Descriptions should highlight:
   - Unique selling points
   - Promotions/offers
   - Trust signals (Free Shipping, 100% Guarantee, etc.)
5. All text must be in {language}
6. Do NOT use special characters or emojis

Return ONLY valid JSON:
{{"headlines": ["h1", "h2", ...], "descriptions": ["d1", "d2", ...]}}"""

        messages = [{"role": "user", "content": prompt}]

        try:
            raw = self.gen_service._call_with_fallback(messages, max_tokens=2048, fast=True)
            result = self._parse_json(raw)
            # 验证和截断
            headlines = [h[:RSA_HEADLINE_MAX] for h in result.get("headlines", [])[:RSA_HEADLINE_COUNT]]
            descriptions = [d[:RSA_DESC_MAX] for d in result.get("descriptions", [])[:RSA_DESC_COUNT]]

            if len(headlines) < 3:
                raise ValueError(f"AI 只生成了 {len(headlines)} 个标题，至少需要 3 个")
            if len(descriptions) < 2:
                raise ValueError(f"AI 只生成了 {len(descriptions)} 个描述，至少需要 2 个")

            logger.info(f"[AdCopy] 生成 {len(headlines)} 标题 + {len(descriptions)} 描述 for {merchant_name}")
            return {"headlines": headlines, "descriptions": descriptions}

        except Exception as e:
            logger.error(f"[AdCopy] 生成失败: {e}")
            raise ValueError(f"广告素材生成失败: {str(e)}")

    def _parse_json(self, raw: str) -> dict:
        """从 AI 返回中提取 JSON"""
        raw = raw.strip()
        # 尝试直接解析
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass
        # 尝试提取 ```json ... ```
        import re
        m = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', raw, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(1))
            except json.JSONDecodeError:
                pass
        # 尝试找第一个 { ... }
        m = re.search(r'\{.*\}', raw, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
        raise ValueError("AI 返回的内容无法解析为 JSON")


# 单例
ad_copy_generator = AdCopyGenerator()
