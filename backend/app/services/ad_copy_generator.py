"""
AI 广告素材生成服务（CR-039 / CR-048）
使用 Claude/DeepSeek 生成 Google RSA 广告的标题和描述。
支持 SSE 流式输出、历史数据分析、国家语言习惯适配。
"""
import json
import logging
from datetime import date, timedelta
from typing import Dict, List, Optional

from app.services.google_ads_policy import build_policy_prompt

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

import re as _re

_EMOJI_PATTERN = _re.compile(
    "[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF"
    "\U0001F1E0-\U0001F1FF\U00002702-\U000027B0\U000024C2-\U0001F251"
    "\U0001F900-\U0001F9FF\U0001FA00-\U0001FA6F\U0001FA70-\U0001FAFF"
    "\U00002600-\U000026FF\U00002700-\U000027BF\U0000FE00-\U0000FE0F"
    "\U0000200D\U00002B50\U00002B55\U000023CF\U000023E9-\U000023F3"
    "\U000023F8-\U000023FA\U0000231A\U0000231B\U00003030\U000000A9"
    "\U000000AE\U00002122\U00002139\U00002194-\U00002199\U000021A9"
    "\U000021AA\U0000203C\U00002049\U000020E3\U000025AA\U000025AB"
    "\U000025B6\U000025C0\U000025FB-\U000025FE\U00002660\U00002663"
    "\U00002665\U00002666\U00002668\U0000267B\U0000267F\U00002934"
    "\U00002935\U00002B05-\U00002B07\U00002B1B\U00002B1C\U00003297"
    "\U00003299\U0000FE0F\U0000200D]+",
    flags=_re.UNICODE,
)


def _strip_emoji(text: str) -> str:
    return _EMOJI_PATTERN.sub("", text).strip()


def _has_bad_translation(text: str, merchant_name: str) -> bool:
    """判断翻译是否无效（空、只有品牌名等）"""
    brand_lower = merchant_name.lower().strip()
    cleaned = text.strip().lower().replace("：", "").replace(":", "").replace(".", "").replace("!", "").replace("！", "")
    if not cleaned:
        return True
    for variant in (brand_lower, brand_lower.replace(" ", ""), brand_lower.replace("-", "")):
        if cleaned == variant:
            return True
    return len(cleaned) <= len(brand_lower) + 2


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

        policy_prompt = build_policy_prompt(merchant_name, category)

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
{policy_prompt}

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

**第五步：合规检查**
根据上述 Google Ads 政策规则，检查文案是否有违规风险，如有则修正。

**第六步：生成文案**
按照{country_name}的{language}语言习惯，生成以下内容：
- 15 条标题（每条 ≤ 30 字符）
- 4 条描述（每条 ≤ 90 字符）
- 每条都要附带中文翻译

返回 JSON 格式（thinking 字段包含第一步到第五步的所有分析，recommended_budget 是建议日预算）:
{{"thinking": "第一步...\\n第二步...\\n第三步...\\n第四步...\\n第五步...", "recommended_budget": 10, "headlines": ["Shop TYMO Now", ...], "headline_translations": ["立即选购TYMO", ...], "descriptions": ["d1", ...], "description_translations": ["完整中文翻译句子", ...]}}
翻译规则（极其重要！）: headline_translations 和 description_translations 每一条都必须翻译英文文案的完整含义。
错误示范: "BRUNT"、"TYMO" ← 禁止只写品牌名！ 正确示范: "BRUNT Boots: Built Tough" → "BRUNT靴子：坚韧耐用\""""

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

        # ── 爬取商家网站真实运费/折扣/退货信息 ──
        merchant_facts = ""
        if merchant_url:
            try:
                import httpx, re
                from bs4 import BeautifulSoup as _BS
                _headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
                with httpx.Client(timeout=6, follow_redirects=True) as _c:
                    resp = _c.get(merchant_url, headers=_headers)
                    if resp.status_code < 400:
                        text = resp.text[:15000]  # 只取前15KB
                        soup = _BS(text, "lxml")
                        page_text = soup.get_text(separator=" ", strip=True)

                        facts = []
                        # 提取运费信息
                        shipping_patterns = [
                            r'free\s+shipping\s+(?:on\s+orders?\s+)?(?:over|above)\s+\$[\d,.]+',
                            r'free\s+shipping\s+(?:on\s+orders?\s+)?(?:over|above)\s+[\d,.]+',
                            r'free\s+(?:standard\s+)?shipping',
                            r'\$[\d,.]+\s+(?:flat\s+rate\s+)?shipping',
                            r'ships?\s+free',
                        ]
                        for pat in shipping_patterns:
                            m = re.search(pat, page_text, re.IGNORECASE)
                            if m:
                                facts.append(f"运费: {m.group(0).strip()}")
                                break

                        # 提取折扣信息
                        discount_patterns = [
                            r'(?:up\s+to\s+)?\d{1,2}%\s+off',
                            r'save\s+(?:up\s+to\s+)?\d{1,2}%',
                            r'(?:extra\s+)?\d{1,2}%\s+(?:off|discount)',
                            r'\$\d+\s+off',
                        ]
                        for pat in discount_patterns:
                            m = re.search(pat, page_text, re.IGNORECASE)
                            if m:
                                facts.append(f"折扣: {m.group(0).strip()}")
                                break

                        # 提取退货信息
                        return_patterns = [
                            r'free\s+returns?',
                            r'\d+[\s-]day\s+returns?',
                            r'easy\s+returns?',
                            r'return\s+(?:within\s+)?\d+\s+days?',
                        ]
                        for pat in return_patterns:
                            m = re.search(pat, page_text, re.IGNORECASE)
                            if m:
                                facts.append(f"退货: {m.group(0).strip()}")
                                break

                        # 提取 banner / announcement bar 文字
                        for bar in soup.find_all(["div", "p", "span"], class_=lambda c: c and any(
                            x in (c if isinstance(c, str) else " ".join(c)).lower()
                            for x in ["announcement", "banner", "promo-bar", "top-bar", "header-bar", "marquee"]
                        )):
                            bar_text = bar.get_text(strip=True)
                            if bar_text and 10 < len(bar_text) < 120:
                                facts.append(f"官网横幅: {bar_text}")
                                break

                        if facts:
                            merchant_facts = "\n\n## 商家网站真实信息（从官网爬取，必须严格使用，禁止编造）:\n" + "\n".join(f"- {f}" for f in facts)
                            merchant_facts += "\n⚠️ 重要：文案中的运费、折扣、退货等信息必须与上述官网数据完全一致，不得修改金额或条件！"
            except Exception as e:
                logger.warning(f"[AdCopy] 爬取商家信息失败: {e}")

        # 构建精简版政策合规提示（流式版控制长度）
        from app.services.google_ads_policy import detect_restricted_categories, EDITORIAL_RULES, PROHIBITED_CONTENT_RULES
        restricted = detect_restricted_categories(merchant_name, category)
        policy_section = """合规要求（Google Ads 政策数据库 — 必须严格遵守）:
- 禁止夸大宣传/误导性承诺/虚假紧迫感
- 禁止全大写单词(品牌缩写除外)/gimmick式大写
- 禁止标题中使用感叹号/连续重复标点/emoji表情符号
- 禁止使用他人商标/暗示官方关联
- 禁止无法验证的最高级声明(如"Best in the world")
- 禁止"Guaranteed results""Miracle""No risk""100% success"等词
- 所有价格/折扣/免运费声明必须在着陆页可验证
- 文案必须语法正确、与着陆页内容相关"""
        if restricted:
            labels = [r["label"] for r in restricted]
            policy_section += f"\n⚠️ 限制品类警告 [{', '.join(labels)}]:"
            for r in restricted:
                # 取政策的前几行关键规则
                lines = [l.strip() for l in r["policy"].strip().split("\n") if l.strip().startswith("- ")]
                policy_section += "\n" + "\n".join(lines[:6])

        return f"""你是资深 Google Ads RSA 文案专家，精通{country_name}市场。

商家: {merchant_name} | 网站: {merchant_url} | 品类: {category or '综合'}
关键词: {kw_text}
目标市场: {country_name} ({language}) | 风格: {style}
{context_ref}
{merchant_facts}

请先用中文写3-5行简要分析（商家定位、策略要点、预算建议），然后输出JSON。

{policy_section}

JSON格式(严格遵守):
```json
{{"recommended_budget": 10, "headlines": ["共15条标题"], "headline_translations": ["共15条中文翻译"], "descriptions": ["共4条描述"], "description_translations": ["共4条中文翻译"], "sitelinks": [{{"link_text": "链接文字", "desc1": "描述行1", "desc2": "描述行2", "path": "/子路径"}}], "callouts": ["卖点1", "卖点2", "卖点3", "卖点4"]}}
```

## 标题生成策略（15条，严格按以下顺序排列）:
1. 第1条: 品牌强关联 — 必须包含品牌名"{merchant_name}"，突出品牌核心价值和定位
2. 第2条: 最大折扣力度 — 优选商家最大的折扣信息（如"Up to 60% Off"），必须在着陆页可验证
3. 第3条: 物流信息 — 针对{country_name}本国的物流优势（如"Free Shipping to {country_name}"），仅限本国物流
4. 第4-6条: 次要折扣/促销 — 其他折扣信息、限时优惠、满减活动等
5. 第7-10条: 产品卖点 — 突出产品品质、材质、设计、用户评价等
6. 第11-13条: 行动号召 — 引导点击的CTA（如"Shop Now"、"Discover More"）
7. 第14-15条: 差异化优势 — 与竞品的区别、独特卖点、品牌故事

## 标题规则:
- 正好15条，每条严格≤30字符（含空格和标点）
- 30字符参考: "Shop TYMO Hair Tools - 50% Off"正好30字符
- 尽量避免过多大写字符（品牌缩写除外）
- 折扣和物流信息必须真实，在着陆页可验证
- 不得使用感叹号、emoji、全大写单词

## 描述生成策略（4条）:
1. 第1条: 必须同时包含折扣信息和物流信息（如"Save up to 50% on {merchant_name}. Free shipping on orders over $XX to {country_name}."）
2. 第2条: 产品品质和品牌故事（突出工艺、材质、设计理念）
3. 第3条: 用户信任和保障（退货政策、客户评价、售后服务）
4. 第4条: 行动号召+限时感（引导立即购买，突出稀缺性或时效性）

## 描述规则:
- 正好4条，每条字数必须在50-80字符之间（含空格和标点）
- 低于50字符的描述太短，缺乏说服力，必须补充内容
- 超过80字符的描述太长，必须精简
- 80字符参考: "Shop premium denim at Current Elliott. Free shipping on orders over $150. Easy returns."正好80字符
- 50字符参考: "Discover vintage-inspired jeans. Free shipping available."正好55字符

## 站内链接（sitelinks）:
- 正好6条，link_text≤25字符，desc1和desc2各≤35字符
- path是商家网站真实存在的子路径（如/shop/women、/collections/new-arrivals）
- 必须是商家网站上真实存在的页面，不要编造不存在的路径

## 宣传信息（callouts）:
- 正好4条，每条≤25字符
- 突出商家核心卖点（如免运费、退货保障、品质保证等）

## 翻译规则（极其重要！）:
- headline_translations 和 description_translations 每一条都必须是完整的中文翻译句子
- 错误示范: "BRUNT"、"TYMO"、"品牌名" ← 这些不是翻译，禁止出现！
- 正确示范: "BRUNT Boots: Built Tough" → "BRUNT靴子：坚韧耐用"

## 其他规则:
- 写完每条都要数一下字符数，超出的必须改短，不足50字符的描述必须补充
- 严禁使用任何emoji表情符号
- 文案用{language}，翻译用中文
- 语言描述需要具有品牌特色，符合{country_name}消费者语言习惯
- 完全符合Google Ads平台规范，不得欺骗、误导消费者
- 所有折扣、价格、物流信息必须真实可验证"""

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

            headlines = [_strip_emoji(h) for h in result.get("headlines", [])[:RSA_HEADLINE_COUNT]]
            descriptions = [_strip_emoji(d) for d in result.get("descriptions", [])[:RSA_DESC_COUNT]]
            thinking = result.get("thinking", "")
            headline_translations = [_strip_emoji(t) for t in result.get("headline_translations", [])[:len(headlines)]]
            description_translations = [_strip_emoji(t) for t in result.get("description_translations", [])[:len(descriptions)]]
            recommended_budget = result.get("recommended_budget", 10)

            headlines, descriptions, headline_translations, description_translations = self._post_process(
                headlines, descriptions, headline_translations, description_translations, merchant_name,
            )

            if len(headlines) < 3:
                raise ValueError(f"AI 只生成了 {len(headlines)} 个标题，至少需要 3 个")
            if len(descriptions) < 2:
                raise ValueError(f"AI 只生成了 {len(descriptions)} 个描述，至少需要 2 个")

            sitelinks = result.get("sitelinks", [])[:6]
            callouts = [_strip_emoji(c)[:25] for c in result.get("callouts", [])[:6]]

            logger.info(f"[AdCopy] 生成 {len(headlines)} 标题 + {len(descriptions)} 描述 + {len(sitelinks)} 站内链接 + {len(callouts)} 宣传 for {merchant_name}")
            return {
                "headlines": headlines,
                "descriptions": descriptions,
                "headline_translations": headline_translations,
                "description_translations": description_translations,
                "thinking": thinking,
                "recommended_budget": recommended_budget,
                "sitelinks": sitelinks,
                "callouts": callouts,
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
            "max_tokens": 3000,
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
            headlines = [_strip_emoji(h) for h in result.get("headlines", [])[:RSA_HEADLINE_COUNT]]
            descriptions = [_strip_emoji(d) for d in result.get("descriptions", [])[:RSA_DESC_COUNT]]
            headline_translations = [_strip_emoji(t) for t in result.get("headline_translations", [])[:len(headlines)]]
            description_translations = [_strip_emoji(t) for t in result.get("description_translations", [])[:len(descriptions)]]
            recommended_budget = result.get("recommended_budget", 10)

            headlines, descriptions, headline_translations, description_translations = self._post_process(
                headlines, descriptions, headline_translations, description_translations, merchant_name,
            )

            sitelinks = result.get("sitelinks", [])[:6]
            callouts = [_strip_emoji(c)[:25] for c in result.get("callouts", [])[:6]]

            final = {
                "headlines": headlines,
                "descriptions": descriptions,
                "headline_translations": headline_translations,
                "description_translations": description_translations,
                "recommended_budget": recommended_budget,
                "sitelinks": sitelinks,
                "callouts": callouts,
            }
            yield f"<<FINAL_JSON>>{json.dumps(final, ensure_ascii=False)}"
        except Exception as e:
            logger.error(f"[AdCopy] 流式生成失败: {e}")
            yield f"<<ERROR>>{str(e)}"

    def _post_process(self, headlines, descriptions, h_trans, d_trans, merchant_name):
        """一次性修复所有问题：超长文案 + 无效翻译，最多 1 次 AI 调用"""
        while len(h_trans) < len(headlines):
            h_trans.append("")
        while len(d_trans) < len(descriptions):
            d_trans.append("")

        # 收集所有需要修复的问题
        issues = []
        overlong_h = [i for i, h in enumerate(headlines) if len(h) > RSA_HEADLINE_MAX]
        overlong_d = [i for i, d in enumerate(descriptions) if len(d) > RSA_DESC_MAX]
        bad_ht = [i for i, t in enumerate(h_trans) if _has_bad_translation(t, merchant_name)]
        bad_dt = [i for i, t in enumerate(d_trans) if _has_bad_translation(t, merchant_name)]

        for i in overlong_h:
            issues.append(f"标题{i+1}超长({len(headlines[i])}字符>30): \"{headlines[i]}\" → 请改写为≤25字符")
        for i in overlong_d:
            issues.append(f"描述{i+1}超长({len(descriptions[i])}字符>90): \"{descriptions[i]}\" → 请改写为≤80字符")
        bad_trans_only_h = [i for i in bad_ht if i not in overlong_h]
        bad_trans_only_d = [i for i in bad_dt if i not in overlong_d]
        for i in bad_trans_only_h:
            issues.append(f"标题{i+1}翻译缺失: \"{headlines[i]}\" → 请提供完整中文翻译")
        for i in bad_trans_only_d:
            issues.append(f"描述{i+1}翻译缺失: \"{descriptions[i]}\" → 请提供完整中文翻译")

        if not issues:
            return headlines, descriptions, h_trans, d_trans

        logger.info("[AdCopy] 后处理: %d 个问题需修复", len(issues))

        fix_indices_h = sorted(set(overlong_h + bad_trans_only_h))
        fix_indices_d = sorted(set(overlong_d + bad_trans_only_d))

        overlong_h_set = set(overlong_h)
        overlong_d_set = set(overlong_d)

        # 分两步处理：超长文案用 AI 改写，翻译缺失用简单翻译 prompt
        # 步骤 1: 修复超长文案（需要改写英文 + 提供翻译）
        if overlong_h or overlong_d:
            rewrite_items = []
            for i in overlong_h:
                rewrite_items.append(f"标题{i+1}({len(headlines[i])}字符>30): \"{headlines[i]}\"")
            for i in overlong_d:
                rewrite_items.append(f"描述{i+1}({len(descriptions[i])}字符>90): \"{descriptions[i]}\"")

            rewrite_prompt = f"""以下广告文案超长，请改写为更短版本。商家: {merchant_name}

{chr(10).join(rewrite_items)}

返回JSON: {{"fixes": [{{"type":"headline或description","index":序号从0开始,"text":"改写后英文","translation":"完整中文翻译"}}]}}
标题≤25字符，描述≤80字符。禁止emoji。翻译必须是完整中文句子。"""

            try:
                raw = self.gen_service._call_with_fallback(
                    [{"role": "user", "content": rewrite_prompt}], max_tokens=1000, fast=True,
                )
                result = self._parse_json(raw)
                for fix in result.get("fixes", []):
                    t, idx = fix.get("type", ""), fix.get("index", -1)
                    new_text = _strip_emoji(fix.get("text", ""))
                    new_trans = _strip_emoji(fix.get("translation", ""))
                    if t == "headline" and idx in overlong_h_set and new_text and len(new_text) <= RSA_HEADLINE_MAX:
                        headlines[idx] = new_text
                        if new_trans:
                            h_trans[idx] = new_trans
                    elif t == "description" and idx in overlong_d_set and new_text and len(new_text) <= RSA_DESC_MAX:
                        descriptions[idx] = new_text
                        if new_trans:
                            d_trans[idx] = new_trans
                logger.info("[AdCopy] 超长修复完成")
            except Exception as e:
                logger.warning("[AdCopy] 超长修复失败: %s", e)

        # 步骤 2: 补翻译（不修改英文文案，只翻译）
        all_bad_trans = []
        for i in bad_trans_only_h:
            all_bad_trans.append((i, "h", headlines[i]))
        for i in bad_trans_only_d:
            all_bad_trans.append((i, "d", descriptions[i]))

        if all_bad_trans:
            items_text = "\n".join(f"{idx+1}. {text}" for idx, _, text in all_bad_trans)
            trans_prompt = f"将以下英文广告文案逐条翻译为完整中文句子，每条一行，只输出翻译：\n{items_text}"
            try:
                raw = self.gen_service._call_with_fallback(
                    [{"role": "user", "content": trans_prompt}], max_tokens=500, fast=True,
                )
                lines = [l.strip() for l in raw.strip().split("\n") if l.strip()]
                lines = [_re.sub(r"^\d+[\.\)、]\s*", "", l) for l in lines]
                for idx_in_list, (orig_idx, cat, _) in enumerate(all_bad_trans):
                    if idx_in_list < len(lines) and lines[idx_in_list]:
                        if cat == "h":
                            h_trans[orig_idx] = lines[idx_in_list]
                        else:
                            d_trans[orig_idx] = lines[idx_in_list]
                logger.info("[AdCopy] 翻译补全完成: %d 条", len(all_bad_trans))
            except Exception as e:
                logger.warning("[AdCopy] 翻译补全失败: %s", e)

        # 本地保底：仍超长的直接截断
        for i, h in enumerate(headlines):
            if len(h) > RSA_HEADLINE_MAX:
                fb = f"Shop {merchant_name}"[:RSA_HEADLINE_MAX]
                logger.warning("[AdCopy] 标题 %d 保底截断: %s → %s", i+1, h, fb)
                headlines[i] = fb
                h_trans[i] = h_trans[i] or ""
        for i, d in enumerate(descriptions):
            if len(d) > RSA_DESC_MAX:
                fb = f"Great deals on {merchant_name}. Shop now and save."[:RSA_DESC_MAX]
                logger.warning("[AdCopy] 描述 %d 保底截断: %s → %s", i+1, d, fb)
                descriptions[i] = fb
                d_trans[i] = d_trans[i] or ""

        # 去重：重复标题替换为空，Google Ads 会自动跳过
        seen_h = set()
        for i, h in enumerate(headlines):
            h_lower = h.strip().lower()
            if h_lower in seen_h:
                logger.warning("[AdCopy] 去重标题 %d: %s", i+1, h)
                headlines[i] = ""
                h_trans[i] = ""
            else:
                seen_h.add(h_lower)
        headlines_clean = [(h, t) for h, t in zip(headlines, h_trans) if h.strip()]
        if headlines_clean:
            headlines[:], h_trans[:] = zip(*headlines_clean)
            headlines, h_trans = list(headlines), list(h_trans)

        # 政策合规检查：移除明显违规的文案
        import re as _re2
        POLICY_VIOLATIONS = [
            # 感叹号在标题中
            (r'!', 'headline_only', '标题含感叹号'),
            # 连续重复标点
            (r'[!?\.]{2,}', 'all', '连续重复标点'),
            # emoji
            (r'[\U0001F300-\U0001F9FF\u2600-\u27BF\u2702-\u27B0\u2764\u2714\u2716\u2728\u2B50\u2B55\u2934\u2935\u25AA\u25AB\u25B6\u25C0\u25FB-\u25FE\u2600-\u26FF\u2700-\u27BF]', 'all', 'emoji符号'),
            # 全大写单词（3+字母，排除常见缩写）
            (r'\b[A-Z]{4,}\b', 'check_brand', '全大写单词'),
            # 禁止的声明
            (r'(?i)\b(guaranteed results?|miracle cure|get rich|no risk|100% success)\b', 'all', '禁止声明'),
        ]
        brand_upper = merchant_name.upper() if merchant_name else ""
        for i, h in enumerate(headlines):
            for pattern, scope, reason in POLICY_VIOLATIONS:
                if scope == 'headline_only' or scope == 'all':
                    if _re2.search(pattern, h):
                        fixed = _re2.sub(pattern, '', h).strip()
                        if fixed and len(fixed) > 5:
                            logger.info("[Policy] 标题%d修复(%s): %s → %s", i+1, reason, h, fixed)
                            headlines[i] = fixed
                elif scope == 'check_brand':
                    matches = _re2.findall(pattern, h)
                    for m in matches:
                        if m != brand_upper and m not in ('USA', 'UK', 'FREE', 'NEW', 'OFF', 'CEO', 'CTO', 'LLC', 'INC', 'LTD'):
                            fixed = h.replace(m, m.title())
                            logger.info("[Policy] 标题%d修复(%s): %s → %s", i+1, reason, h, fixed)
                            headlines[i] = fixed

        return headlines, descriptions, h_trans, d_trans

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
