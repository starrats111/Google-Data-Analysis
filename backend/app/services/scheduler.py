"""
定时任务调度器
用于执行定时数据同步和分析任务
"""
import logging
from datetime import datetime, date, timedelta, timezone

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.services.platform_data_sync import PlatformDataSyncService

from app.services.api_analysis_service import ApiAnalysisService
from app.models.affiliate_account import AffiliateAccount
from app.models.google_ads_api_data import GoogleAdsApiData, GoogleMccAccount


logger = logging.getLogger(__name__)

# 北京时间（UTC+8）
BEIJING_TZ = timezone(timedelta(hours=8))

# 使用北京时间作为调度器的默认时区
scheduler = BackgroundScheduler(timezone=BEIJING_TZ)

# ARCH-2: 全局互斥锁，防止定时任务和手动触发同时操作数据库
import threading
_sync_lock = threading.Lock()


def sync_platform_data_job():
    """同步平台数据任务（每天北京时间4点执行，逐天同步过去5天数据：MID、商家、订单数、佣金、拒付佣金）
    
    注意：
    - 总佣金：包含所有状态的佣金（approved + pending + rejected）
    - 拒付佣金：只包含rejected状态的佣金
    - 已付佣金：只包含approved状态的佣金（每周一同步90天）
    """
    db: Session = SessionLocal()
    try:
        logger.info("=" * 60)
        logger.info("开始执行平台数据同步任务（过去5天，逐天同步）...")
        
        sync_service = PlatformDataSyncService(db)
        
        # 获取所有活跃的联盟账号
        active_accounts = db.query(AffiliateAccount).filter(
            AffiliateAccount.is_active == True
        ).all()
        
        logger.info(f"找到 {len(active_accounts)} 个活跃账号")
        
        # 同步最近5天的数据（确保覆盖可能变化的佣金）
        end_date = date.today() - timedelta(days=1)  # 昨天
        begin_date = end_date - timedelta(days=4)  # 5天前
        
        logger.info(f"时间范围: {begin_date.isoformat()} 至 {end_date.isoformat()} (共5天)")
        
        total_success_count = 0
        total_fail_count = 0
        total_saved = 0
        
        # 逐天同步，确保数据完整
        current_date = begin_date
        while current_date <= end_date:
            logger.info("-" * 60)
            logger.info(f"正在同步日期: {current_date.isoformat()}")
            
            day_success_count = 0
            day_fail_count = 0
            day_saved = 0
            
            # 为每一天同步所有账号
            for account in active_accounts:
                try:
                    logger.info(f"  同步账号: {account.account_name} (平台: {account.platform.platform_name if account.platform else '未知'})")
                    # 逐天同步，每次只同步一天的数据
                    result = sync_service.sync_account_data(
                        account.id,
                        current_date.isoformat(),
                        current_date.isoformat()  # 开始和结束日期相同，只同步一天
                    )
                    
                    if result.get("success"):
                        day_success_count += 1
                        saved_count = result.get("saved_count", 0)
                        day_saved += saved_count
                        logger.info(f"  ✓ 账号 {account.account_name} 同步成功: 保存 {saved_count} 条记录")
                    else:
                        day_fail_count += 1
                        error_msg = result.get('message', '未知错误')
                        logger.error(f"  ✗ 账号 {account.account_name} 同步失败: {error_msg}")
                except Exception as e:
                    day_fail_count += 1
                    logger.error(f"  ✗ 账号 {account.account_name} 同步异常: {e}", exc_info=True)
            
            logger.info(f"日期 {current_date.isoformat()} 同步完成: 成功 {day_success_count} 个账号, 失败 {day_fail_count} 个账号, 保存 {day_saved} 条记录")
            
            total_success_count += day_success_count
            total_fail_count += day_fail_count
            total_saved += day_saved
            
            # 移动到下一天
            current_date += timedelta(days=1)
        
        logger.info("=" * 60)
        logger.info(f"平台数据同步任务完成（逐天同步）:")
        logger.info(f"  - 同步日期数: 5 天")
        logger.info(f"  - 总成功次数: {total_success_count} 次")
        logger.info(f"  - 总失败次数: {total_fail_count} 次")
        logger.info(f"  - 共保存: {total_saved} 条记录")
        logger.info(f"  - 提取字段: MID、商家、订单数、佣金（所有状态）、拒付佣金（rejected状态）")
        logger.info("=" * 60)
        
    except Exception as e:
        logger.error(f"平台数据同步任务执行失败: {e}", exc_info=True)
    finally:
        db.close()


def sync_google_ads_data_job():
    """
    同步Google Ads数据任务（每天北京时间凌晨4点执行）
    
    使用服务账号模式同步所有活跃MCC的广告数据
    仅同步昨天的数据，确保数据精准且节省API配额
    """
    db: Session = SessionLocal()
    try:
        logger.info("=" * 60)
        logger.info("开始执行Google Ads数据同步任务（服务账号模式）...")
        
        from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
        
        sync_service = GoogleAdsServiceAccountSync(db)
        
        # 仅同步昨天的数据
        target_date = date.today() - timedelta(days=1)
        force_refresh = True  # 强制刷新确保数据精准
        
        logger.info(f"同步日期: {target_date.isoformat()} (仅昨天)")
        
        # 批量同步所有活跃MCC
        result = sync_service.sync_all_mccs(
            target_date=target_date,
            only_enabled=False,  # 同步所有状态的广告系列（包括已暂停）
            force_refresh=force_refresh
        )
        
        total_saved = 0
        total_mccs = 0
        
        if result.get("success"):
            total_saved = result.get('total_saved', 0)
            total_mccs = result.get('total_mccs', 0)
            logger.info(f"  ✓ {target_date}: 保存 {total_saved} 条")
            
            if result.get("quota_exhausted"):
                logger.warning("⚠️ 遇到API配额限制")
        else:
            logger.error(f"  ✗ {target_date}: {result.get('message')}")
        
        logger.info(f"✓ Google Ads数据同步完成:")
        logger.info(f"  - MCC总数: {total_mccs}")
        logger.info(f"  - 同步日期: 仅昨天 ({target_date.isoformat()})")
        logger.info(f"  - 总保存记录: {total_saved} 条")
        logger.info("=" * 60)
        
    except Exception as e:
        logger.error(f"✗ Google Ads数据同步任务异常: {e}", exc_info=True)
    finally:
        db.close()


def daily_auto_sync_and_analysis_job():
    """
    每天早上4:00自动执行的统一任务：
    1. 拉取Google Ads数据（仅昨天）
    2. 拉取广告平台数据（过去5天）
    3. 周一额外：同步过去90天平台数据（含已付/拒付佣金）
    4. 生成每日分析
    5. 生成L7D分析（每天执行）
    """
    if not _sync_lock.acquire(blocking=False):
        logger.warning("【每日自动任务跳过】上一轮尚未完成")
        return
    try:
        _daily_auto_sync_and_analysis_inner()
    finally:
        _sync_lock.release()


def _daily_auto_sync_and_analysis_inner():
    logger.info("=" * 60)
    logger.info("【每日自动任务开始】")
    logger.info(f"当前时间: {datetime.now(BEIJING_TZ).strftime('%Y-%m-%d %H:%M:%S')} (北京时间)")
    
    today = date.today()
    weekday = today.weekday()  # 0=周一, 1=周二, ..., 6=周日
    is_monday = (weekday == 0)
    
    logger.info(f"今天是: 星期{['一','二','三','四','五','六','日'][weekday]}")
    if is_monday:
        logger.info("📅 周一：将额外同步过去90天平台佣金数据")
    logger.info("=" * 60)
    
    # 步骤1: 同步Google Ads数据（仅昨天）
    logger.info("\n【步骤1/5】同步Google Ads数据（仅昨天）...")
    try:
        sync_google_ads_data_job()
        logger.info("✓ Google Ads数据同步完成")
    except Exception as e:
        logger.error(f"✗ Google Ads数据同步失败: {e}")
    
    # 步骤2: 同步平台数据（过去5天）
    logger.info("\n【步骤2/5】同步广告平台数据（过去5天）...")
    try:
        sync_platform_data_job()
        logger.info("✓ 广告平台数据同步完成")
    except Exception as e:
        logger.error(f"✗ 广告平台数据同步失败: {e}")
    
    # 步骤3: 周一额外同步过去90天平台数据
    if is_monday:
        logger.info("\n【步骤3/5】周一额外：同步过去90天平台佣金数据...")
        try:
            sync_platform_data_90days_job()
            logger.info("✓ 90天平台佣金数据同步完成")
        except Exception as e:
            logger.error(f"✗ 90天平台佣金数据同步失败: {e}")
    else:
        logger.info("\n【步骤3/5】跳过（仅周一执行90天同步）")
    
    # 步骤4: 生成每日分析
    logger.info("\n【步骤4/5】生成每日分析...")
    try:
        daily_analysis_job()
        logger.info("✓ 每日分析生成完成")
    except Exception as e:
        logger.error(f"✗ 每日分析生成失败: {e}")
    
    # 步骤5: 生成L7D分析（每天执行）
    logger.info("\n【步骤5/5】生成L7D分析...")
    try:
        weekly_l7d_analysis_job()
        logger.info("✓ L7D分析生成完成")
    except Exception as e:
        logger.error(f"✗ L7D分析生成失败: {e}")
    
    logger.info("\n" + "=" * 60)
    logger.info("【每日自动任务完成】")
    logger.info("=" * 60)


def sync_google_ads_historical_job():
    """
    同步Google Ads历史数据任务（手动触发或首次部署时执行）
    
    同步从2026年1月1日至昨天的所有数据
    """
    db: Session = SessionLocal()
    try:
        logger.info("=" * 60)
        logger.info("开始执行Google Ads历史数据同步任务...")
        
        from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
        
        sync_service = GoogleAdsServiceAccountSync(db)
        
        # 历史数据范围：2026年1月1日至昨天
        begin_date = date(2026, 1, 1)
        end_date = date.today() - timedelta(days=1)
        
        logger.info(f"同步日期范围: {begin_date.isoformat()} ~ {end_date.isoformat()}")
        
        # 获取所有活跃MCC
        active_mccs = db.query(GoogleMccAccount).filter(
            GoogleMccAccount.is_active == True
        ).all()
        
        logger.info(f"待同步MCC数量: {len(active_mccs)}")
        
        total_saved = 0
        
        for mcc in active_mccs:
            logger.info(f"同步MCC: {mcc.mcc_name} ({mcc.mcc_id})")
            
            result = sync_service.sync_historical_data(
                mcc.id,
                begin_date,
                end_date,
                force_refresh=False
            )
            
            if result.get("success"):
                saved = result.get("total_saved", 0)
                total_saved += saved
                logger.info(f"  ✓ 完成: 成功{result.get('success_days')}天, "
                           f"失败{result.get('fail_days')}天, 保存{saved}条")
            else:
                logger.error(f"  ✗ 失败: {result.get('message')}")
            
            if result.get("quota_exhausted"):
                logger.warning("⚠️ 遇到配额限制，停止同步")
                break
        
        logger.info(f"历史数据同步完成，共保存 {total_saved} 条记录")
        logger.info("=" * 60)
        
    except Exception as e:
        logger.error(f"✗ Google Ads历史数据同步任务异常: {e}", exc_info=True)
    finally:
        db.close()


def check_mcc_missing_dates(db: Session, mcc_id: int, begin_date: date, end_date: date) -> list:
    """
    检查指定MCC在日期范围内缺失数据的日期
    
    Args:
        db: 数据库会话
        mcc_id: MCC的数据库ID
        begin_date: 开始日期
        end_date: 结束日期
    
    Returns:
        缺失数据的日期列表
    """
    # 查询该MCC已有数据的日期（去重）
    existing_dates_rows = db.query(
        func.distinct(GoogleAdsApiData.date)
    ).filter(
        GoogleAdsApiData.mcc_id == mcc_id,
        GoogleAdsApiData.date >= begin_date,
        GoogleAdsApiData.date <= end_date
    ).all()
    
    existing_set = {row[0] for row in existing_dates_rows}
    
    # 生成完整日期范围
    all_dates = []
    current = begin_date
    while current <= end_date:
        all_dates.append(current)
        current += timedelta(days=1)
    
    # 找出缺失日期
    missing = [d for d in all_dates if d not in existing_set]
    return missing


def backfill_missing_data_job():
    """
    每天 05:00 自动补齐历史缺口（配额感知）

    从 2026-02-01 开始，检查所有 MCC 的缺失日期，
    每次最多补 MAX_BACKFILL_DAYS 天 x MAX_BACKFILL_MCCS 个 MCC，
    CNY 优先，遇到配额耗尽立即停止。
    全部补齐后函数直接 return（零开销）。
    """
    MAX_BACKFILL_MCCS = 2
    MAX_BACKFILL_DAYS = 5
    BACKFILL_BEGIN = date(2026, 2, 1)

    db: Session = SessionLocal()
    try:
        logger.info("=" * 60)
        logger.info("【历史数据自动补齐开始】")
        logger.info(f"当前时间: {datetime.now(BEIJING_TZ).strftime('%Y-%m-%d %H:%M:%S')} (北京时间)")

        from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
        sync_service = GoogleAdsServiceAccountSync(db)

        end_date = date.today() - timedelta(days=1)

        all_mccs = db.query(GoogleMccAccount).filter(
            GoogleMccAccount.is_active == True
        ).all()

        # 为每个 MCC 计算缺失天数，按（CNY优先, 缺口大小降序）排序
        mcc_gaps = []
        for mcc in all_mccs:
            missing = check_mcc_missing_dates(db, mcc.id, BACKFILL_BEGIN, end_date)
            if missing:
                is_cny = 1 if mcc.currency == 'CNY' else 0
                mcc_gaps.append((mcc, missing, is_cny))

        if not mcc_gaps:
            logger.info("所有 MCC 数据已完整，无需补齐")
            logger.info("=" * 60)
            return

        mcc_gaps.sort(key=lambda x: (-x[2], -len(x[1])))

        total_missing = sum(len(g[1]) for g in mcc_gaps)
        logger.info(f"共 {len(mcc_gaps)} 个 MCC 有数据缺口，总缺失 {total_missing} 天")
        logger.info(f"本次最多补齐: {MAX_BACKFILL_MCCS} 个 MCC x {MAX_BACKFILL_DAYS} 天")
        logger.info("=" * 60)

        total_saved = 0
        total_synced = 0
        mccs_processed = 0
        quota_exhausted = False

        for mcc, missing_dates, is_cny in mcc_gaps:
            if mccs_processed >= MAX_BACKFILL_MCCS or quota_exhausted:
                break

            currency_tag = "CNY" if is_cny else "USD"
            dates_this_round = missing_dates[:MAX_BACKFILL_DAYS]

            logger.info(f"\nMCC {mcc.mcc_id} ({mcc.mcc_name}) [{currency_tag}]")
            logger.info(f"  缺失 {len(missing_dates)} 天，本次补 {len(dates_this_round)} 天")

            for target_date in dates_this_round:
                try:
                    result = sync_service.sync_mcc_data(
                        mcc.id, target_date, force_refresh=False
                    )
                    if result.get("success"):
                        saved = result.get("saved_count", 0)
                        total_saved += saved
                        total_synced += 1
                        logger.info(f"  {target_date}: {saved} 条")
                    else:
                        logger.warning(f"  {target_date}: {result.get('message', '')[:80]}")

                    if result.get("quota_exhausted"):
                        logger.warning("配额耗尽，停止补齐")
                        quota_exhausted = True
                        break
                except Exception as e:
                    logger.error(f"  {target_date} 异常: {e}")

            mccs_processed += 1

        remaining = total_missing - total_synced
        logger.info("\n" + "=" * 60)
        logger.info("【历史数据自动补齐完成】")
        logger.info(f"  本次补齐: {total_synced} 天, {total_saved} 条")
        logger.info(f"  剩余缺口: {remaining} 天")
        if remaining > 0:
            logger.info(f"  将在明天 05:00 继续补齐")
        if quota_exhausted:
            logger.warning("  注意: 遇到配额限制，提前终止")
        logger.info("=" * 60)

    except Exception as e:
        logger.error(f"历史数据自动补齐任务异常: {e}", exc_info=True)
    finally:
        db.close()


def daily_analysis_job():
    """每日分析任务（每天北京时间早上8点05分执行，取前一天的平台数据和对应商家的Google ads数据进行每日分析）"""
    db: Session = SessionLocal()
    try:
        logger.info("=" * 60)
        logger.info("开始执行每日分析任务...")
        
        # 分析昨天的数据
        target_date = date.today() - timedelta(days=1)
        logger.info(f"分析日期: {target_date.isoformat()}")
        logger.info("数据来源: 前一天的平台数据 + 对应商家的Google Ads数据")
        
        # 调用API分析服务
        api_analysis_service = ApiAnalysisService(db)
        
        # 为所有用户生成每日分析（user_id=None表示所有用户）
        result = api_analysis_service.generate_daily_analysis(target_date, user_id=None)
        
        if result.get("success"):
            total_records = result.get("total_records", 0)
            logger.info(f"✓ 每日分析任务完成: {target_date.isoformat()}, 共生成 {total_records} 条记录")
        else:
            logger.error(f"✗ 每日分析任务失败: {result.get('message')}")
        
        logger.info("=" * 60)
        
    except Exception as e:
        logger.error(f"✗ 每日分析任务执行失败: {e}", exc_info=True)
    finally:
        db.close()


def weekly_l7d_analysis_job():
    """每周L7D分析任务（每周一/三/五北京时间早上8点10分自动生成L7D数据）"""
    db: Session = SessionLocal()
    try:
        logger.info("=" * 60)
        logger.info("开始执行每周L7D分析任务...")

        # 结束日期为昨天（不包含今天）
        end_date = date.today() - timedelta(days=1)
        begin_date = end_date - timedelta(days=6)
        
        logger.info(f"分析日期范围: {begin_date.isoformat()} 至 {end_date.isoformat()} (过去7天)")

        api_analysis_service = ApiAnalysisService(db)

        # 为所有用户生成L7D分析（user_id=None表示所有用户）
        result = api_analysis_service.generate_l7d_analysis(end_date, user_id=None)

        if result.get("success"):
            logger.info(
                "✓ 每周L7D分析任务完成: %s 至 %s, 共生成 %s 条记录",
                result.get("begin_date"),
                result.get("end_date"),
                result.get("total_records", 0),
            )
        else:
            logger.error(f"✗ 每周L7D分析任务失败: {result.get('message')}")

        logger.info("=" * 60)

    except Exception as e:
        logger.error("✗ 每周L7D分析任务执行失败: %s", e, exc_info=True)
    finally:
        db.close()


def sync_platform_data_90days_job():
    """周一同步过去90天平台佣金任务（包含已付佣金和拒付佣金）
    
    每周一早上4点执行，同步过去90天的所有佣金数据，
    确保长周期内的佣金状态变化（如从pending变为approved/rejected）被正确更新
    """
    db: Session = SessionLocal()
    try:
        logger.info("=" * 60)
        logger.info("开始执行90天平台佣金同步任务（周一专用）...")
        
        sync_service = PlatformDataSyncService(db)
        
        # 获取所有活跃的联盟账号
        active_accounts = db.query(AffiliateAccount).filter(
            AffiliateAccount.is_active == True
        ).all()
        
        logger.info(f"找到 {len(active_accounts)} 个活跃账号")
        
        # 同步过去90天的数据
        end_date = date.today() - timedelta(days=1)  # 昨天
        begin_date = end_date - timedelta(days=89)  # 90天前
        
        logger.info(f"时间范围: {begin_date.isoformat()} 至 {end_date.isoformat()} (共90天)")
        logger.info("同步所有状态的佣金（含已付佣金和拒付佣金）")
        
        total_success_count = 0
        total_fail_count = 0
        total_saved = 0
        
        # 逐天同步
        current_date = begin_date
        while current_date <= end_date:
            logger.info("-" * 60)
            logger.info(f"正在同步日期: {current_date.isoformat()}")
            
            day_success_count = 0
            day_fail_count = 0
            day_saved = 0
            
            for account in active_accounts:
                try:
                    logger.info(f"  同步账号: {account.account_name} (平台: {account.platform.platform_name if account.platform else '未知'})")
                    result = sync_service.sync_account_data(
                        account.id,
                        current_date.isoformat(),
                        current_date.isoformat()
                    )
                    
                    if result.get("success"):
                        day_success_count += 1
                        saved_count = result.get("saved_count", 0)
                        day_saved += saved_count
                        logger.info(f"    ✓ 成功，保存 {saved_count} 条")
                    else:
                        day_fail_count += 1
                        logger.warning(f"    ✗ 失败: {result.get('message')}")
                        
                except Exception as e:
                    day_fail_count += 1
                    logger.error(f"    ✗ 异常: {e}")
            
            total_success_count += day_success_count
            total_fail_count += day_fail_count
            total_saved += day_saved
            
            logger.info(f"日期 {current_date.isoformat()} 完成: 成功 {day_success_count}, 失败 {day_fail_count}, 保存 {day_saved} 条")
            
            current_date += timedelta(days=1)
        
        logger.info("=" * 60)
        logger.info(f"90天平台佣金同步任务完成（周一专用）:")
        logger.info(f"  - 同步日期数: 90 天")
        logger.info(f"  - 总成功次数: {total_success_count} 次")
        logger.info(f"  - 总失败次数: {total_fail_count} 次")
        logger.info(f"  - 共保存: {total_saved} 条记录")
        logger.info(f"  - 包含: 已付佣金（approved）、拒付佣金（rejected）、待审核佣金（pending）")
        logger.info("=" * 60)
        
    except Exception as e:
        logger.error(f"✗ 90天平台佣金同步任务异常: {e}", exc_info=True)
    finally:
        db.close()


def sync_approved_commission_job():
    """同步已付佣金任务（每月1号和15号北京时间00:00执行，同步所有状态的订单，更新已付佣金字段）"""
    db: Session = SessionLocal()
    try:
        logger.info("=" * 60)
        logger.info("开始执行已付佣金同步任务...")
        
        sync_service = PlatformDataSyncService(db)
        
        # 获取所有活跃的联盟账号
        active_accounts = db.query(AffiliateAccount).filter(
            AffiliateAccount.is_active == True
        ).all()
        
        logger.info(f"找到 {len(active_accounts)} 个活跃账号")
        
        # 同步最近90天的数据（确保覆盖可能状态变化的订单）
        end_date = date.today() - timedelta(days=1)  # 昨天
        begin_date = end_date - timedelta(days=89)  # 90天前
        
        logger.info(f"时间范围: {begin_date.isoformat()} 至 {end_date.isoformat()} (共90天)")
        logger.info("同步所有状态的订单，更新已付佣金（approved状态）")
        
        total_success_count = 0
        total_fail_count = 0
        total_saved = 0
        
        # 逐天同步
        current_date = begin_date
        while current_date <= end_date:
            logger.info("-" * 60)
            logger.info(f"正在同步日期: {current_date.isoformat()}")
            
            day_success_count = 0
            day_fail_count = 0
            day_saved = 0
            
            # 为每一天同步所有账号
            for account in active_accounts:
                try:
                    logger.info(f"  同步账号: {account.account_name} (平台: {account.platform.platform_name if account.platform else '未知'})")
                    # 逐天同步，每次只同步一天的数据
                    result = sync_service.sync_account_data(
                        account.id,
                        current_date.isoformat(),
                        current_date.isoformat()  # 开始和结束日期相同，只同步一天
                    )
                    
                    if result.get("success"):
                        day_success_count += 1
                        saved_count = result.get("saved_count", 0)
                        day_saved += saved_count
                        logger.info(f"  ✓ 账号 {account.account_name} 同步成功: 保存 {saved_count} 条记录")
                    else:
                        day_fail_count += 1
                        error_msg = result.get('message', '未知错误')
                        logger.error(f"  ✗ 账号 {account.account_name} 同步失败: {error_msg}")
                except Exception as e:
                    day_fail_count += 1
                    logger.error(f"  ✗ 账号 {account.account_name} 同步异常: {e}", exc_info=True)
            
            logger.info(f"日期 {current_date.isoformat()} 同步完成: 成功 {day_success_count} 个账号, 失败 {day_fail_count} 个账号, 保存 {day_saved} 条记录")
            
            total_success_count += day_success_count
            total_fail_count += day_fail_count
            total_saved += day_saved
            
            # 移动到下一天
            current_date += timedelta(days=1)
        
        logger.info("=" * 60)
        logger.info(f"已付佣金同步任务完成:")
        logger.info(f"  - 同步日期数: 90 天")
        logger.info(f"  - 总成功次数: {total_success_count} 次")
        logger.info(f"  - 总失败次数: {total_fail_count} 次")
        logger.info(f"  - 共保存: {total_saved} 条记录")
        logger.info(f"  - 更新字段: 已付佣金（approved状态的佣金）")
        logger.info("=" * 60)
        
    except Exception as e:
        logger.error(f"已付佣金同步任务执行失败: {e}", exc_info=True)
    finally:
        db.close()



def database_backup_job():
    """数据库自动备份任务（每天北京时间 03:00 执行）"""
    try:
        from app.services.backup_service import backup_database
        logger.info("=" * 60)
        logger.info("开始执行数据库自动备份...")
        result = backup_database()
        if result.get("success"):
            logger.info(f"数据库备份完成: {result.get('path')} ({result.get('size_mb')} MB)")
        else:
            logger.error(f"数据库备份失败: {result.get('message')}")
        logger.info("=" * 60)
    except Exception as e:
        logger.error(f"数据库备份任务异常: {e}", exc_info=True)


def start_scheduler():
    """启动定时任务调度器"""
    if scheduler.running:
        logger.warning("调度器已在运行")
        return
    
    try:
        # 1. 每天 04:00 - 核心同步：Google Ads 昨日 + 平台数据 + 分析
        scheduler.add_job(
            daily_auto_sync_and_analysis_job,
            trigger=CronTrigger(hour=4, minute=0),
            id='daily_auto_sync_and_analysis',
            name='每日自动同步与分析（4:00）',
            replace_existing=True,
            max_instances=1
        )
        
        # 2. 每天 05:00 - 历史数据自动补齐（配额感知，全部补完后零开销）
        scheduler.add_job(
            backfill_missing_data_job,
            trigger=CronTrigger(hour=5, minute=0),
            id='backfill_missing_data',
            name='历史数据自动补齐（5:00）',
            replace_existing=True,
            max_instances=1
        )
        
        # 3. 每天 16:00 - 平台数据补充同步
        scheduler.add_job(
            sync_platform_data_job,
            trigger=CronTrigger(hour=16, minute=0),
            id='sync_platform_data_afternoon',
            name='平台数据补充同步（16:00）',
            replace_existing=True,
            max_instances=1
        )
        
        # 4. 每月 1/15 号 00:00 - 已付佣金同步
        scheduler.add_job(
            sync_approved_commission_job,
            trigger=CronTrigger(day="1,15", hour=0, minute=0),
            id='sync_approved_commission',
            name='同步已付佣金',
            replace_existing=True,
            max_instances=1
        )
        
        # 5. 每天 03:00 - 数据库自动备份（SEC-8）
        scheduler.add_job(
            database_backup_job,
            trigger=CronTrigger(hour=3, minute=0),
            id='database_backup',
            name='数据库自动备份（3:00）',
            replace_existing=True,
            max_instances=1
        )
        
        scheduler.start()
        logger.info("=" * 60)
        logger.info("定时任务调度器已启动")
        logger.info("已注册任务:")
        logger.info("  1. 每日自动同步与分析: 每天 04:00")
        logger.info("     (Google Ads昨日 + 平台数据5天 + 周一90天佣金 + 分析 + L7D)")
        logger.info("  2. 历史数据自动补齐: 每天 05:00")
        logger.info("     (CNY优先, 每次最多3MCC x 10天, 全部补完后零开销)")
        logger.info("  3. 平台数据补充同步: 每天 16:00")
        logger.info("  4. 已付佣金同步: 每月1/15号 00:00")
        logger.info("  5. 数据库自动备份: 每天 03:00")
        logger.info("=" * 60)
        
    except Exception as e:
        logger.error(f"启动定时任务调度器失败: {e}")


def shutdown_scheduler():
    """关闭定时任务调度器"""
    if scheduler.running:
        scheduler.shutdown()
        logger.info("定时任务调度器已关闭")

