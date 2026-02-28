"""
Google Ads API 全局速率限制器

实现双重限制：
1. 每分钟请求数上限（默认 50 次/分钟，留 17% 安全余量）
2. 每日请求总量上限（默认 15,000 次/天）

所有 Google Ads API 调用都应通过此限制器的 acquire() 方法获取许可后再执行。
该限制器是进程级单例，手动同步和定时任务共享同一个实例。
"""
import time
import threading
import logging
from datetime import date
from typing import Optional

logger = logging.getLogger(__name__)


class GoogleAdsRateLimiter:
    """
    Google Ads API 速率限制器（线程安全）

    使用滑动窗口算法控制每分钟请求数，
    使用每日计数器控制每日总量。
    """

    def __init__(self, max_per_minute: int = 50, max_per_day: int = 15000):
        self._lock = threading.Lock()
        self._minute_timestamps: list[float] = []
        self._daily_count: int = 0
        self._daily_reset_date: Optional[date] = None
        self.max_per_minute = max_per_minute
        self.max_per_day = max_per_day

    def acquire(self) -> bool:
        """
        获取一个请求许可。

        - 如果每分钟请求数已达上限，会阻塞等待直到窗口滑过。
        - 如果每日配额已用完，返回 False（调用方应停止同步）。

        Returns:
            True  — 许可已获取，可以发起 API 请求
            False — 每日配额已耗尽，应停止同步
        """
        with self._lock:
            now = time.time()
            today = date.today()

            # ── 每日计数重置 ──
            if self._daily_reset_date != today:
                if self._daily_count > 0:
                    logger.info(
                        f"[RateLimiter] 新的一天，重置每日计数器"
                        f"（昨日消耗: {self._daily_count}）"
                    )
                self._daily_count = 0
                self._daily_reset_date = today

            # ── 检查每日配额 ──
            if self._daily_count >= self.max_per_day:
                logger.warning(
                    f"[RateLimiter] 每日配额已耗尽"
                    f"（{self._daily_count}/{self.max_per_day}）"
                )
                return False

            # ── 滑动窗口：清理超过 60 秒的时间戳 ──
            self._minute_timestamps = [
                t for t in self._minute_timestamps if now - t < 60
            ]

            # ── 如果 1 分钟内请求数达到上限，阻塞等待 ──
            if len(self._minute_timestamps) >= self.max_per_minute:
                oldest = self._minute_timestamps[0]
                wait_time = 60.0 - (now - oldest) + 0.1  # 多等 0.1s 确保窗口滑过
                if wait_time > 0:
                    logger.debug(
                        f"[RateLimiter] 每分钟上限已达"
                        f"（{len(self._minute_timestamps)}/{self.max_per_minute}），"
                        f"等待 {wait_time:.1f}s"
                    )
                    # 释放锁后等待，避免阻塞其他线程
                    self._lock.release()
                    try:
                        time.sleep(wait_time)
                    finally:
                        self._lock.acquire()
                    # 等待后重新清理
                    now = time.time()
                    self._minute_timestamps = [
                        t for t in self._minute_timestamps if now - t < 60
                    ]

            # ── 记录本次请求 ──
            self._minute_timestamps.append(time.time())
            self._daily_count += 1

            # 每 500 次记录一次日志
            if self._daily_count % 500 == 0:
                logger.info(
                    f"[RateLimiter] 今日已消耗 {self._daily_count}/{self.max_per_day} 次配额"
                )

            return True

    @property
    def daily_remaining(self) -> int:
        """剩余每日配额"""
        with self._lock:
            today = date.today()
            if self._daily_reset_date != today:
                return self.max_per_day
            return max(0, self.max_per_day - self._daily_count)

    @property
    def daily_used(self) -> int:
        """今日已使用配额"""
        with self._lock:
            today = date.today()
            if self._daily_reset_date != today:
                return 0
            return self._daily_count

    @property
    def minute_used(self) -> int:
        """当前分钟内已使用次数"""
        with self._lock:
            now = time.time()
            return len([t for t in self._minute_timestamps if now - t < 60])


# ── 进程级单例 ──
# 所有模块 import 后共享同一个实例
_global_limiter: Optional[GoogleAdsRateLimiter] = None
_init_lock = threading.Lock()


def get_rate_limiter() -> GoogleAdsRateLimiter:
    """
    获取全局速率限制器单例。

    首次调用时会从 settings 读取配置参数创建实例，
    后续调用返回同一个实例。
    """
    global _global_limiter
    if _global_limiter is None:
        with _init_lock:
            if _global_limiter is None:
                try:
                    from app.config import settings
                    max_per_minute = getattr(
                        settings, "google_ads_max_requests_per_minute", 50
                    )
                    max_per_day = getattr(
                        settings, "google_ads_daily_quota", 15000
                    )
                except Exception:
                    max_per_minute = 50
                    max_per_day = 15000

                _global_limiter = GoogleAdsRateLimiter(
                    max_per_minute=max_per_minute,
                    max_per_day=max_per_day,
                )
                logger.info(
                    f"[RateLimiter] 全局速率限制器已初始化: "
                    f"{max_per_minute} 次/分钟, {max_per_day} 次/天"
                )
    return _global_limiter
