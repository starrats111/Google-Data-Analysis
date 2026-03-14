"""
节日营销服务 — 提供节日数据查询与商家推荐
支持 8 个国家的公共假日 + 全球商业节日，通过 AI 生成关键词匹配推荐商家。
"""
import json
import logging
from datetime import date, timedelta
from typing import Dict, List, Optional

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

COUNTRY_CODE_MAP = {
    "US": "US", "UK": "GB", "CA": "CA", "AU": "AU",
    "DE": "DE", "FR": "FR", "JP": "JP", "BR": "BR",
}

COUNTRY_NAME_MAP = {
    "US": ("美国", "United States"),
    "UK": ("英国", "United Kingdom"),
    "CA": ("加拿大", "Canada"),
    "AU": ("澳大利亚", "Australia"),
    "DE": ("德国", "Germany"),
    "FR": ("法国", "France"),
    "JP": ("日本", "Japan"),
    "BR": ("巴西", "Brazil"),
}

COMMERCIAL_HOLIDAYS: List[Dict] = [
    {"month": 1, "day": 1, "name": "New Year's Day", "name_zh": "元旦", "countries": ["US", "UK", "CA", "AU", "DE", "FR", "JP", "BR"]},
    {"month": 2, "day": 14, "name": "Valentine's Day", "name_zh": "情人节", "countries": ["US", "UK", "CA", "AU", "DE", "FR", "BR"]},
    {"month": 3, "day": 8, "name": "International Women's Day", "name_zh": "国际妇女节", "countries": ["US", "UK", "CA", "AU", "DE", "FR", "JP", "BR"]},
    {"month": 3, "day": 14, "name": "White Day", "name_zh": "白色情人节", "countries": ["JP"]},
    {"month": 5, "day": 1, "name": "Labour Day", "name_zh": "劳动节", "countries": ["DE", "FR", "BR"]},
    {"month": 6, "day": 18, "name": "Father's Day", "name_zh": "父亲节", "countries": ["US", "UK", "CA"]},
    {"month": 10, "day": 31, "name": "Halloween", "name_zh": "万圣节", "countries": ["US", "UK", "CA", "AU"]},
    {"month": 11, "day": 11, "name": "Singles' Day", "name_zh": "双十一", "countries": ["US", "UK", "CA", "AU", "DE", "FR", "JP", "BR"]},
    {"month": 12, "day": 25, "name": "Christmas", "name_zh": "圣诞节", "countries": ["US", "UK", "CA", "AU", "DE", "FR", "BR"]},
    {"month": 12, "day": 26, "name": "Boxing Day", "name_zh": "节礼日", "countries": ["UK", "CA", "AU"]},
    {"month": 12, "day": 31, "name": "New Year's Eve", "name_zh": "跨年夜", "countries": ["US", "UK", "CA", "AU", "DE", "FR", "JP", "BR"]},
]

# 浮动日期商业节日 — 按年计算
def _floating_commercial_holidays(year: int) -> List[Dict]:
    """母亲节、父亲节、感恩节、黑色星期五等浮动日期节日"""
    import calendar
    result = []

    def nth_weekday(y, m, n, weekday):
        """第 n 个 weekday (0=Mon, 6=Sun)"""
        cal = calendar.monthcalendar(y, m)
        count = 0
        for week in cal:
            if week[weekday] != 0:
                count += 1
                if count == n:
                    return date(y, m, week[weekday])
        return None

    def last_weekday(y, m, weekday):
        cal = calendar.monthcalendar(y, m)
        for week in reversed(cal):
            if week[weekday] != 0:
                return date(y, m, week[weekday])
        return None

    mothers_day_us = nth_weekday(year, 5, 2, 6)  # 5月第2个周日
    if mothers_day_us:
        result.append({"date": mothers_day_us, "name": "Mother's Day", "name_zh": "母亲节",
                        "countries": ["US", "CA", "AU", "BR"], "type": "commercial"})

    mothers_day_uk = nth_weekday(year, 3, 4, 6)  # 英国: 3月第4个周日 (近似)
    if mothers_day_uk:
        result.append({"date": mothers_day_uk, "name": "Mother's Day", "name_zh": "母亲节",
                        "countries": ["UK"], "type": "commercial"})

    fathers_day = nth_weekday(year, 6, 3, 6)  # 6月第3个周日
    if fathers_day:
        result.append({"date": fathers_day, "name": "Father's Day", "name_zh": "父亲节",
                        "countries": ["US", "UK", "CA"], "type": "commercial"})

    thanksgiving = nth_weekday(year, 11, 4, 3)  # 11月第4个周四
    if thanksgiving:
        result.append({"date": thanksgiving, "name": "Thanksgiving", "name_zh": "感恩节",
                        "countries": ["US"], "type": "commercial"})
        black_friday = thanksgiving + timedelta(days=1)
        result.append({"date": black_friday, "name": "Black Friday", "name_zh": "黑色星期五",
                        "countries": ["US", "UK", "CA", "AU", "DE", "FR", "BR"], "type": "commercial"})
        cyber_monday = thanksgiving + timedelta(days=4)
        result.append({"date": cyber_monday, "name": "Cyber Monday", "name_zh": "网络星期一",
                        "countries": ["US", "UK", "CA", "AU", "DE"], "type": "commercial"})

    return result


def get_upcoming_holidays(country_code: str, days: int = 30) -> List[Dict]:
    """获取指定国家未来 N 天内的节日（公共 + 商业）"""
    today = date.today()
    end_date = today + timedelta(days=days)
    result = []

    lib_code = COUNTRY_CODE_MAP.get(country_code, country_code)
    try:
        import holidays as holidays_lib
        country_holidays = holidays_lib.country_holidays(lib_code, years=[today.year, end_date.year])
        for d, name in sorted(country_holidays.items()):
            dt = d if isinstance(d, date) else date.fromisoformat(str(d))
            if today <= dt <= end_date:
                result.append({
                    "date": dt.isoformat(),
                    "name": name,
                    "name_zh": name,
                    "type": "public",
                })
    except Exception as e:
        logger.warning(f"[Holiday] holidays 库查询失败 ({lib_code}): {e}")

    for h in COMMERCIAL_HOLIDAYS:
        if country_code not in h.get("countries", []):
            continue
        for year in [today.year, today.year + 1]:
            try:
                dt = date(year, h["month"], h["day"])
            except ValueError:
                continue
            if today <= dt <= end_date:
                if not any(r["date"] == dt.isoformat() and r["name"] == h["name"] for r in result):
                    result.append({
                        "date": dt.isoformat(),
                        "name": h["name"],
                        "name_zh": h["name_zh"],
                        "type": "commercial",
                    })

    for fh in _floating_commercial_holidays(today.year) + _floating_commercial_holidays(end_date.year):
        if country_code not in fh.get("countries", []):
            continue
        dt = fh["date"]
        if today <= dt <= end_date:
            if not any(r["date"] == dt.isoformat() and r["name"] == fh["name"] for r in result):
                result.append({
                    "date": dt.isoformat(),
                    "name": fh["name"],
                    "name_zh": fh["name_zh"],
                    "type": fh.get("type", "commercial"),
                })

    result.sort(key=lambda x: x["date"])
    return result


def recommend_merchants_for_holiday(
    holiday_name: str,
    country_code: str,
    db: Session,
    user_id: int,
) -> List[Dict]:
    """用 AI 生成关键词，在商家库中匹配推荐商家"""
    from app.models.merchant import AffiliateMerchant
    from app.models.campaign_link_cache import CampaignLinkCache

    user_platforms = (
        db.query(func.distinct(CampaignLinkCache.platform_code))
        .filter(CampaignLinkCache.user_id == user_id)
        .all()
    )
    platform_list = [p[0] for p in user_platforms] if user_platforms else []
    if not platform_list:
        return []

    keywords = _ai_holiday_keywords(holiday_name, country_code)

    conditions = []
    for kw in keywords:
        pattern = f"%{kw}%"
        conditions.append(AffiliateMerchant.merchant_name.ilike(pattern))
        conditions.append(AffiliateMerchant.category.ilike(pattern))

    if not conditions:
        return []

    q = db.query(AffiliateMerchant).filter(
        or_(*conditions),
        func.upper(AffiliateMerchant.platform).in_([p.upper() for p in platform_list]),
        AffiliateMerchant.status == "active",
    ).limit(50)

    merchants = q.all()
    return [
        {
            "id": m.id,
            "merchant_id": m.merchant_id,
            "merchant_name": m.merchant_name,
            "platform": m.platform,
            "category": m.category,
            "commission_rate": m.commission_rate,
            "slug": m.slug,
        }
        for m in merchants
    ]


def _ai_holiday_keywords(holiday_name: str, country_code: str) -> List[str]:
    """调用 AI 为节日生成商家搜索关键词"""
    try:
        from app.services.article_gen_service import ArticleGenService
        svc = ArticleGenService()

        country_zh = COUNTRY_NAME_MAP.get(country_code, ("", ""))[0]
        prompt = f"""你是电商营销专家。给定节日「{holiday_name}」和目标市场「{country_zh}」，
请生成 8-12 个最相关的英文商品/品牌类别关键词，用于从联盟商家库中搜索适合做节日促销的商家。

要求:
- 只返回关键词，一行一个
- 关键词为英文，简洁（1-3个单词）
- 覆盖礼品、服饰、美妆、电子、食品等可能相关的类别
- 按相关度排序

示例格式:
jewelry
flowers
chocolate
fashion
beauty"""

        messages = [{"role": "user", "content": prompt}]
        raw = svc._call_with_fallback(messages, max_tokens=300, fast=True)
        keywords = [line.strip().lower() for line in raw.strip().split("\n") if line.strip() and not line.strip().startswith("-")]
        keywords = [kw.lstrip("0123456789. ") for kw in keywords]
        keywords = [kw for kw in keywords if 1 < len(kw) < 40]
        return keywords[:12]
    except Exception as e:
        logger.error(f"[Holiday] AI 关键词生成失败: {e}")
        return _fallback_keywords(holiday_name)


def _fallback_keywords(holiday_name: str) -> List[str]:
    """AI 不可用时的静态关键词映射"""
    name_lower = holiday_name.lower()
    mapping = {
        "valentine": ["jewelry", "flowers", "chocolate", "perfume", "gift", "fashion", "beauty", "lingerie"],
        "mother": ["flowers", "jewelry", "beauty", "spa", "gift", "fashion", "handbag", "perfume"],
        "father": ["electronics", "watch", "sport", "tool", "gift", "fashion", "outdoor"],
        "christmas": ["gift", "toy", "electronics", "fashion", "beauty", "decoration", "food", "jewelry"],
        "halloween": ["costume", "candy", "decoration", "party", "makeup"],
        "black friday": ["electronics", "fashion", "beauty", "home", "sport", "toy"],
        "cyber monday": ["electronics", "software", "fashion", "beauty", "gadget"],
        "easter": ["chocolate", "gift", "decoration", "food", "fashion", "toy"],
        "thanksgiving": ["food", "kitchen", "home", "gift", "wine"],
        "new year": ["party", "fashion", "beauty", "gift", "decoration", "wine", "travel"],
        "singles": ["electronics", "fashion", "beauty", "self-care", "gadget"],
    }
    for key, kws in mapping.items():
        if key in name_lower:
            return kws
    return ["gift", "fashion", "beauty", "electronics", "home"]
