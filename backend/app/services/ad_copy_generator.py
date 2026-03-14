"""
AI 广告素材生成服务（CR-039 / CR-048）
使用 Claude/DeepSeek 生成 Google RSA 广告的标题和描述。
支持 SSE 流式输出、历史数据分析、国家语言习惯适配。
"""
import json
import logging
from datetime import date, timedelta
from typing import Dict, List, Optional

from sqlalchemy import func as sa_func
from sqlalchemy.orm import Session

from app.services.article_gen_service import ArticleGenService

logger = logging.getLogger(__name__)

COUNTRY_LANGUAGE_MAP = {
    "US": {"name": "美国", "language": "English (US)", "style": "直接、行动导向、强调价值和优惠"},
    "UK": {"name": "英国", "language": "English (UK)", "style": "含蓄、品质导向、用英式拼写如 colour/favourite"},
    "CA": {"name": "加拿大", "language": "English (CA)", "style": "混合美式英式、强调环保可持续"},
    "AU": {"name": "澳大利亚", "language": "English (AU)", "style": "随和口语化、强调户外生活方式"},
    "DE": {"name": "德国", "language": "German", "style": "严谨、技术参数导向、强调品质认证"},
    "FR": {"name": "法国", "language": "French", "style": "优雅、强调设计美学和生活品味"},
    "JP": {"name": "日本", "language": "Japanese", "style": "礼貌、详细、强调服务和可靠性"},
    "BR": {"name": "巴西", "language": "Portuguese (BR)", "style": "热情、情感导向、强调社交证明"},
}


def analyze_user_campaigns(user_id: int, mcc_id: int, db: Session) -> Dict:
    """分析用户 MCC 下的历史广告表现，找出高 CTR / 高佣金的广告系列。"""
    from app.models.google_ads_api_data import GoogleAdsApiData
    from app.models.affiliate_transaction import AffiliateTransaction

    since = date.today() - timedelta(days=30)

    rows = (
        db.query(
            GoogleAdsApiData.campaign_id,
            GoogleAdsApiData.campaign_name,
            GoogleAdsApiData.extracted_platform_code,
            GoogleAdsApiData.extracted_account_code,
            sa_func.sum(GoogleAdsApiData.clicks).label("total_clicks"),
            sa_func.sum(GoogleAdsApiData.impressions).label("total_impressions"),
            sa_func.sum(GoogleAdsApiData.cost).label("total_cost"),
            sa_func.avg(GoogleAdsApiData.cpc).label("avg_cpc"),
        )
        .filter(
            GoogleAdsApiData.user_id == user_id,
            GoogleAdsApiData.mcc_id == mcc_id,
            GoogleAdsApiData.date >= since,
            GoogleAdsApiData.impressions > 0,
        )
        .group_by(GoogleAdsApiData.campaign_id, GoogleAdsApiData.campaign_name,
                   GoogleAdsApiData.extracted_platform_code, GoogleAdsApiData.extracted_account_code)
        .all()
    )

    campaigns = []
    for r in rows:
        ctr = (r.total_clicks / r.total_impressions * 100) if r.total_impressions else 0
        commission = 0.0
        if r.extracted_platform_code and r.extracted_account_code:
            comm_row = (
                db.query(sa_func.sum(AffiliateTransaction.commission_amount))
                .filter(
                    AffiliateTransaction.platform == r.extracted_platform_code,
                    AffiliateTransaction.merchant_id == r.extracted_account_code,
                    AffiliateTransaction.transaction_time >= since,
                    AffiliateTransaction.status == "approved",
                )
                .scalar()
            )
            commission = float(comm_row or 0)

        campaigns.append({
            "campaign_id": r.campaign_id,
            "campaign_name": r.campaign_name,
            "clicks": int(r.total_clicks or 0),
            "impressions": int(r.total_impressions or 0),
            "ctr": round(ctr, 2),
            "cost": round(float(r.total_cost or 0), 2),
            "avg_cpc": round(float(r.avg_cpc or 0), 2),
            "commission": round(commission, 2),
            "roi": round(commission / float(r.total_cost) * 100, 1) if r.total_cost and r.total_cost > 0 else 0,
        })

    campaigns.sort(key=lambda c: (c["ctr"] * 0.4 + c["roi"] * 0.6), reverse=True)

    return {
        "total_campaigns": len(campaigns),
        "top_campaigns": campaigns[:5],
        "has_data": len(campaigns) > 0,
    }

# RSA 广告限制
RSA_HEADLINE_MAX = 30  # 标题最大字符数
RSA_HEADLINE_COUNT = 15  # 最多 15 个标题
RSA_DESC_MAX = 90  # 描述最大字符数
RSA_DESC_COUNT = 4  # 最多 4 个描述


class AdCopyGenerator:
    """AI 广告文案生成器"""

    def __init__(self):
        self.gen_service = ArticleGenService()

    def _build_prompt(
        self,
        merchant_name: str,
        merchant_url: str,
        keywords: List[Dict],
        target_country: str = "US",
        history: Optional[Dict] = None,
        category: str = "",
    ) -> str:
        """组装增强版 Prompt（含国家语言习惯 + 历史参照）—— 仅非流式接口使用"""
        country_info = COUNTRY_LANGUAGE_MAP.get(target_country, COUNTRY_LANGUAGE_MAP["US"])
        country_name = country_info["name"]
        language = country_info["language"]
        style = country_info["style"]

        top_keywords = [kw["keyword"] for kw in keywords[:10]]
        kw_text = ", ".join(top_keywords) if top_keywords else merchant_name

        history_section = ""
        if history and history.get("has_data"):
            lines = []
            for i, c in enumerate(history["top_campaigns"][:3], 1):
                line = (
                    f"{i}. \"{c['campaign_name']}\": "
                    f"CTR={c['ctr']}%, 花费=${c['cost']}, "
                    f"佣金=${c['commission']}, ROI={c['roi']}%"
                )
                lines.append(line)
            history_section = f"""
## 该员工的历史广告表现（参考数据，近30天）
共分析了 {history['total_campaigns']} 个广告系列，以下是表现最好的：
{chr(10).join(lines)}
"""
        else:
            history_section = "\n## 该员工的历史广告表现\n该员工暂无历史广告数据，无参照系。\n"

        best_campaign = ""
        if history and history.get("top_campaigns"):
            best_campaign = history["top_campaigns"][0]["campaign_name"]

        return f"""你是一位资深 Google Ads 广告优化专家，精通{country_name}市场。

## 商家信息
- 商家名称: {merchant_name}
- 商家网站: {merchant_url}
- 品类: {category or '综合'}
- 已研究的关键词: {kw_text}

## 投放国家与语言
- 目标国家: {country_name}
- 广告语言: {language}
- 该国消费者语言风格: {style}
- 请严格按照{country_name}的语言习惯生成广告文案
{history_section}
## Google Ads 政策合规（必须遵守）
- 禁止夸大宣传、误导性承诺、点击诱导
- 禁止全大写（品牌缩写除外）、过度标点
- 禁止使用他人商标、违禁内容
- 使用专业、真实、可信的语言

## 你的输出（必须全部用中文思考，文案用{language}）

请按以下步骤逐一分析并输出：

**第一步：商家分析**
分析 {merchant_name} 的主营业务、核心产品/服务、目标客群。

**第二步：市场洞察**
分析{country_name}市场对该类产品的需求趋势、竞争程度、当地消费者的购买特点。

**第三步：历史参照**
{"参照该员工表现最好的广告系列「" + best_campaign + "」，分析其高回报率的原因，说明你将如何借鉴这些经验来设计新文案。" if best_campaign else "该员工暂无历史数据，基于行业经验给出建议。"}

**第四步：策略规划**
说明你将从哪些角度切入，搭配哪些关键词，预计能获得较高成交率。给出日预算建议（USD）。

**第五步：生成文案**
按照{country_name}的{language}语言习惯，生成以下内容：
- 15 条标题（每条 ≤ 30 字符）
- 4 条描述（每条 ≤ 90 字符）
- 每条都要附带中文翻译

返回 JSON 格式（thinking 字段包含第一步到第四步的所有分析，recommended_budget 是建议日预算）:
{{"thinking": "第一步...\\n第二步...\\n第三步...\\n第四步...", "recommended_budget": 10, "headlines": ["h1", ...], "headline_translations": ["翻译1", ...], "descriptions": ["d1", ...], "description_translations": ["翻译1", ...]}}"""

    def _build_prompt_fast(
        self,
        merchant_name: str,
        merchant_url: str,
        keywords: List[Dict],
        target_country: str = "US",
        history: Optional[Dict] = None,
        category: str = "",
        holiday_name: Optional[str] = None,
    ) -> str:
        """精简版 Prompt —— 流式接口专用，保留质量、大幅减少输出 token"""
        country_info = COUNTRY_LANGUAGE_MAP.get(target_country, COUNTRY_LANGUAGE_MAP["US"])
        language = country_info["language"]
        style = country_info["style"]
        country_name = country_info["name"]

        top_keywords = [kw["keyword"] for kw in keywords[:10]]
        kw_text = ", ".join(top_keywords) if top_keywords else merchant_name

        context_ref = ""
        if holiday_name:
            context_ref = f"🎉 节日营销: {holiday_name} — 文案必须贴合该节日氛围，突出节日特色、购物需求和情感共鸣，使用节日相关词汇和情感表达。"
        elif history and history.get("has_data") and history.get("top_campaigns"):
            best = history["top_campaigns"][0]
            context_ref = f"参考该员工最佳广告「{best['campaign_name']}」(CTR={best['ctr']}%, ROI={best['roi']}%)的成功经验。"

        return f"""你是资深 Google Ads RSA 文案专家，精通{country_name}市场。

商家: {merchant_name} | 网站: {merchant_url} | 品类: {category or '综合'}
关键词: {kw_text}
目标市场: {country_name} ({language}) | 风格: {style}
{context_ref}

请先用中文写3-5行简要分析（商家定位、策略要点、预算建议），然后输出JSON。

合规要求: 禁止夸大宣传/误导/全大写(品牌缩写除外)/他人商标。

JSON格式(严格遵守):
```json
{{"recommended_budget": 10, "headlines": ["15条{language}标题,每条≤30字符"], "headline_translations": ["15条中文翻译"], "descriptions": ["4条{language}描述,每条≤90字符"], "description_translations": ["4条中文翻译"]}}
```

要求:
- 标题正好15条，每条严格≤30字符
- 描述正好4条，每条严格≤90字符
- 文案用{language}，翻译用中文
- 专业、真实、符合{country_name}消费者语言习惯"""

    def generate_ad_copy(
        self,
        merchant_name: str,
        merchant_url: str,
        keywords: List[Dict],
        category: str = "",
        language: str = "en",
        target_country: str = "US",
        history: Optional[Dict] = None,
    ) -> Dict:
        """生成 RSA 广告素材（标题 + 描述 + AI 思考过程）"""
        prompt = self._build_prompt(
            merchant_name, merchant_url, keywords,
            target_country, history, category,
        )
        messages = [{"role": "user", "content": prompt}]

        try:
            raw = self.gen_service._call_with_fallback(messages, max_tokens=4000, fast=True)
            result = self._parse_json(raw)

            headlines = [h[:RSA_HEADLINE_MAX] for h in result.get("headlines", [])[:RSA_HEADLINE_COUNT]]
            descriptions = [d[:RSA_DESC_MAX] for d in result.get("descriptions", [])[:RSA_DESC_COUNT]]
            thinking = result.get("thinking", "")
            headline_translations = result.get("headline_translations", [])[:len(headlines)]
            description_translations = result.get("description_translations", [])[:len(descriptions)]
            recommended_budget = result.get("recommended_budget", 10)

            while len(headline_translations) < len(headlines):
                headline_translations.append("")
            while len(description_translations) < len(descriptions):
                description_translations.append("")

            if len(headlines) < 3:
                raise ValueError(f"AI 只生成了 {len(headlines)} 个标题，至少需要 3 个")
            if len(descriptions) < 2:
                raise ValueError(f"AI 只生成了 {len(descriptions)} 个描述，至少需要 2 个")

            logger.info(f"[AdCopy] 生成 {len(headlines)} 标题 + {len(descriptions)} 描述 for {merchant_name}")
            return {
                "headlines": headlines,
                "descriptions": descriptions,
                "headline_translations": headline_translations,
                "description_translations": description_translations,
                "thinking": thinking,
                "recommended_budget": recommended_budget,
            }

        except Exception as e:
            logger.error(f"[AdCopy] 生成失败: {e}")
            raise ValueError(f"广告素材生成失败: {str(e)}")

    def generate_ad_copy_stream(
        self,
        merchant_name: str,
        merchant_url: str,
        keywords: List[Dict],
        target_country: str = "US",
        history: Optional[Dict] = None,
        category: str = "",
        holiday_name: Optional[str] = None,
    ):
        """流式生成 RSA 广告素材（优化版：精简 Prompt、降低 token 开销）。
        yield 每个 text chunk，最终 yield "<<FINAL_JSON>>..." 包含完整结果。
        """
        import httpx
        from app.config import settings

        prompt = self._build_prompt_fast(
            merchant_name, merchant_url, keywords,
            target_country, history, category,
            holiday_name=holiday_name,
        )
        messages = [{"role": "user", "content": prompt}]
        url = f"{settings.gemini_base_url.rstrip('/')}/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {settings.gemini_api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": "deepseek-chat",
            "messages": messages,
            "max_tokens": 2000,
            "temperature": 0.5,
            "stream": True,
        }

        full_text = ""
        try:
            with httpx.Client(timeout=90) as client:
                with client.stream("POST", url, json=payload, headers=headers) as resp:
                    resp.raise_for_status()
                    for line in resp.iter_lines():
                        if not line or not line.startswith("data: "):
                            continue
                        data_str = line[6:]
                        if data_str.strip() == "[DONE]":
                            break
                        try:
                            chunk_data = json.loads(data_str)
                            delta = chunk_data.get("choices", [{}])[0].get("delta", {})
                            content = delta.get("content", "")
                            if content:
                                full_text += content
                                yield content
                        except json.JSONDecodeError:
                            continue

            result = self._parse_json(full_text)
            headlines = [h[:RSA_HEADLINE_MAX] for h in result.get("headlines", [])[:RSA_HEADLINE_COUNT]]
            descriptions = [d[:RSA_DESC_MAX] for d in result.get("descriptions", [])[:RSA_DESC_COUNT]]
            headline_translations = result.get("headline_translations", [])[:len(headlines)]
            description_translations = result.get("description_translations", [])[:len(descriptions)]
            recommended_budget = result.get("recommended_budget", 10)

            while len(headline_translations) < len(headlines):
                headline_translations.append("")
            while len(description_translations) < len(descriptions):
                description_translations.append("")

            final = {
                "headlines": headlines,
                "descriptions": descriptions,
                "headline_translations": headline_translations,
                "description_translations": description_translations,
                "recommended_budget": recommended_budget,
            }
            yield f"<<FINAL_JSON>>{json.dumps(final, ensure_ascii=False)}"
        except Exception as e:
            logger.error(f"[AdCopy] 流式生成失败: {e}")
            yield f"<<ERROR>>{str(e)}"

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
