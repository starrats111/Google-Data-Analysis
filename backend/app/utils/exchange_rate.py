"""
实时汇率工具模块
- 从免费 API 获取 CNY→USD 汇率
- 内存缓存 + 数据库缓存，避免频繁请求
- API 不可用时回退到配置值
"""
import logging
import time
from typing import Optional

import requests

logger = logging.getLogger(__name__)

_cache: dict = {"rate": None, "ts": 0}
CACHE_TTL = 6 * 3600  # 6 小时

FALLBACK_RATE = 7.2
FREE_API_URLS = [
    "https://open.er-api.com/v6/latest/USD",
    "https://api.exchangerate-api.com/v4/latest/USD",
]


def _fetch_rate_from_api() -> Optional[float]:
    """从免费汇率 API 获取 1 USD = ? CNY"""
    for url in FREE_API_URLS:
        try:
            resp = requests.get(url, timeout=8)
            if resp.status_code == 200:
                data = resp.json()
                rates = data.get("rates", {})
                cny = rates.get("CNY")
                if cny and isinstance(cny, (int, float)) and cny > 0:
                    logger.info("汇率 API 返回: 1 USD = %.4f CNY (source: %s)", cny, url)
                    return float(cny)
        except Exception as e:
            logger.warning("汇率 API 请求失败 (%s): %s", url, e)
            continue
    return None


def get_cny_to_usd_rate() -> float:
    """
    获取 CNY→USD 汇率 (即 1 USD = ? CNY)。
    CNY 金额 ÷ 该值 = USD 金额。

    优先使用缓存，过期后重新获取。API 全部失败时回退到配置文件值。
    """
    now = time.time()
    if _cache["rate"] and (now - _cache["ts"]) < CACHE_TTL:
        return _cache["rate"]

    rate = _fetch_rate_from_api()
    if rate:
        _cache["rate"] = rate
        _cache["ts"] = now
        return rate

    if _cache["rate"]:
        logger.warning("汇率 API 不可用，使用上次缓存值: %.4f", _cache["rate"])
        return _cache["rate"]

    try:
        from app.config import settings
        fallback = float(getattr(settings, "CNY_TO_USD_RATE", FALLBACK_RATE) or FALLBACK_RATE)
    except Exception:
        fallback = FALLBACK_RATE
    logger.warning("汇率 API 不可用，使用配置回退值: %.4f", fallback)
    return fallback


def convert_to_usd(amount: float, currency: str) -> float:
    """将金额转换为美元。非 CNY 货币原样返回。"""
    if not currency or currency.upper() != "CNY":
        return amount
    rate = get_cny_to_usd_rate()
    return amount / rate
