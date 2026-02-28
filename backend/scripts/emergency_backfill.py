#!/usr/bin/env python3
"""
紧急补齐脚本 - 补齐最近7天缺失的 Google Ads 数据

策略:
- 只补最近 7 天 (昨天往前推7天) 的缺失数据
- 按 MCC 逐个补齐，每个 customer 请求之间加 2 秒延迟
- 每个 MCC 之间加 30 秒冷却
- 遇到 429 时解析 "Retry in N second" 提取实际等待时间
- 最近日期优先补齐

用法 (在服务器上执行):
  cd ~/Google-Data-Analysis/backend
  source venv/bin/activate
  python scripts/emergency_backfill.py
"""
import os
import sys
import re
import time
import logging
from datetime import date, timedelta, datetime

# 确保能导入 app 模块
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal
from app.models.google_ads_api_data import GoogleAdsApiData, GoogleMccAccount
from sqlalchemy import func

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("emergency_backfill")

# ── 配置 ──────────────────────────────────────────────
LOOKBACK_DAYS = 7           # 补齐最近 7 天
CUSTOMER_DELAY = 2.5        # 每个 customer 请求间隔 (秒)，留 60% 余量
MCC_COOLDOWN = 60           # 每个 MCC 完成后冷却 (秒)，确保滑动窗口重置
RETRY_EXTRA = 10            # 429 retry 秒数额外加的缓冲
MAX_RETRIES = 5             # 单个 customer 最大重试次数
# ─────────────────────────────────────────────────────


def parse_retry_seconds(error_str: str) -> int:
    """从 429 错误信息中提取 'Retry in N second' 的 N"""
    m = re.search(r"[Rr]etry\s+in\s+(\d+)\s*s", error_str)
    if m:
        return int(m.group(1))
    return 60  # 默认 60 秒


def get_missing_dates(db, mcc_id: int, begin: date, end: date) -> list:
    """获取指定 MCC 在日期范围内缺失的日期"""
    existing = db.query(
        func.distinct(GoogleAdsApiData.date)
    ).filter(
        GoogleAdsApiData.mcc_id == mcc_id,
        GoogleAdsApiData.date >= begin,
        GoogleAdsApiData.date <= end,
    ).all()
    existing_set = {row[0] for row in existing}

    all_dates = []
    cur = begin
    while cur <= end:
        all_dates.append(cur)
        cur += timedelta(days=1)

    missing = [d for d in all_dates if d not in existing_set]
    # 最近日期优先
    missing.sort(reverse=True)
    return missing


def main():
    db = SessionLocal()
    try:
        end_date = date.today() - timedelta(days=1)
        begin_date = end_date - timedelta(days=LOOKBACK_DAYS - 1)

        logger.info("=" * 60)
        logger.info("紧急补齐脚本启动")
        logger.info(f"补齐范围: {begin_date} ~ {end_date} ({LOOKBACK_DAYS} 天)")
        logger.info(f"Customer 延迟: {CUSTOMER_DELAY}s, MCC 冷却: {MCC_COOLDOWN}s")
        logger.info("=" * 60)

        # 获取所有活跃 MCC
        mccs = db.query(GoogleMccAccount).filter(
            GoogleMccAccount.is_active == True
        ).all()
        logger.info(f"活跃 MCC 数量: {len(mccs)}")

        # 计算每个 MCC 的缺失天数，按缺失多的优先
        mcc_gaps = []
        for mcc in mccs:
            missing = get_missing_dates(db, mcc.id, begin_date, end_date)
            if missing:
                mcc_gaps.append((mcc, missing))
                logger.info(
                    f"  {mcc.mcc_name} ({mcc.mcc_id}): "
                    f"缺 {len(missing)} 天 {[d.isoformat() for d in missing]}"
                )

        if not mcc_gaps:
            logger.info("所有 MCC 最近 7 天数据完整，无需补齐!")
            return

        # 按缺失天数降序排列
        mcc_gaps.sort(key=lambda x: -len(x[1]))

        total_ops = sum(
            len(missing) * (mcc.total_customers or 40)
            for mcc, missing in mcc_gaps
        )
        logger.info(f"\n需要补齐: {len(mcc_gaps)} 个 MCC, 预计 ~{total_ops} 次 API 调用")
        logger.info(f"预计耗时: ~{total_ops * CUSTOMER_DELAY / 60 + len(mcc_gaps) * MCC_COOLDOWN / 60:.0f} 分钟")
        logger.info("")

        # 延迟导入同步服务 (需要 app 上下文)
        from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
        sync_service = GoogleAdsServiceAccountSync(db)

        total_saved = 0
        total_synced = 0
        total_failed = 0
        quota_exhausted = False

        for mcc_idx, (mcc, missing_dates) in enumerate(mcc_gaps):
            if quota_exhausted:
                logger.warning("配额耗尽，停止补齐")
                break

            logger.info(f"\n{'─' * 50}")
            logger.info(
                f"[{mcc_idx + 1}/{len(mcc_gaps)}] {mcc.mcc_name} ({mcc.mcc_id}) "
                f"- 补 {len(missing_dates)} 天"
            )

            for date_idx, target_date in enumerate(missing_dates):
                if quota_exhausted:
                    break

                logger.info(
                    f"  [{date_idx + 1}/{len(missing_dates)}] "
                    f"同步 {target_date.isoformat()}..."
                )

                try:
                    result = sync_service.sync_mcc_data(
                        mcc.id,
                        target_date,
                        force_refresh=False,
                        only_enabled=False,
                    )

                    if result.get("success"):
                        saved = result.get("saved_count", 0)
                        total_saved += saved
                        total_synced += 1
                        skipped = result.get("skipped", False)
                        if skipped:
                            logger.info(f"    已存在，跳过")
                        else:
                            logger.info(f"    保存 {saved} 条记录")
                    else:
                        msg = result.get("message", "未知错误")
                        if result.get("quota_exhausted"):
                            # 解析 retry 秒数
                            retry_sec = parse_retry_seconds(msg)
                            wait = retry_sec + RETRY_EXTRA
                            logger.warning(
                                f"    配额限制! 等待 {wait}s (retry={retry_sec}s)..."
                            )
                            time.sleep(wait)
                            # 重试一次
                            result2 = sync_service.sync_mcc_data(
                                mcc.id, target_date,
                                force_refresh=False, only_enabled=False,
                            )
                            if result2.get("success"):
                                saved = result2.get("saved_count", 0)
                                total_saved += saved
                                total_synced += 1
                                logger.info(f"    重试成功! 保存 {saved} 条")
                            else:
                                logger.error(f"    重试仍失败: {result2.get('message')}")
                                if result2.get("quota_exhausted"):
                                    quota_exhausted = True
                                total_failed += 1
                        else:
                            logger.warning(f"    失败: {msg}")
                            total_failed += 1

                except Exception as e:
                    error_str = str(e)
                    logger.error(f"    异常: {error_str[:200]}")
                    if "429" in error_str or "quota" in error_str.lower():
                        retry_sec = parse_retry_seconds(error_str)
                        wait = retry_sec + RETRY_EXTRA
                        logger.warning(f"    配额异常，等待 {wait}s...")
                        time.sleep(wait)
                    total_failed += 1

                # 日期间短暂延迟
                if date_idx < len(missing_dates) - 1:
                    time.sleep(3)

            # MCC 间冷却
            if mcc_idx < len(mcc_gaps) - 1 and not quota_exhausted:
                logger.info(f"  MCC 冷却 {MCC_COOLDOWN}s...")
                time.sleep(MCC_COOLDOWN)

        # 汇总
        logger.info("\n" + "=" * 60)
        logger.info("紧急补齐完成!")
        logger.info(f"  成功同步: {total_synced} 天")
        logger.info(f"  保存记录: {total_saved} 条")
        logger.info(f"  失败: {total_failed} 天")
        logger.info(f"  配额耗尽: {'是' if quota_exhausted else '否'}")
        logger.info("=" * 60)

    finally:
        db.close()


if __name__ == "__main__":
    main()
