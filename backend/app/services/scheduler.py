"""
定时任务调度器
用于执行定时数据同步和分析任务
"""
import logging
import time
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
from app.models.user import User
from app.models.affiliate_transaction import AffiliateTransaction
from app.models.notification import Notification
from app.models.commission_snapshot import CommissionSnapshot
from app.config import settings

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
    1. 先同步脚本模式 MCC（从 Google Sheet 读取）
    2. 再同步 API 模式 MCC（现有逻辑）
    """
    db: Session = SessionLocal()
    try:
        logger.info("=" * 60)
        logger.info("开始执行Google Ads数据同步任务...")

        # OPT-005：先同步脚本模式 MCC（2s 间隔）
        from app.models.google_ads_api_data import GoogleMccAccount
        from app.services.google_sheet_sync import GoogleSheetSyncService
        script_mccs = db.query(GoogleMccAccount).filter(
            GoogleMccAccount.is_active == True,
            GoogleMccAccount.sync_mode == "script",
            GoogleMccAccount.google_sheet_url.isnot(None),
            GoogleMccAccount.google_sheet_url != "",
        ).all()
        if script_mccs:
            logger.info("同步 %d 个脚本模式 MCC（Google Sheet）...", len(script_mccs))
            sheet_service = GoogleSheetSyncService(db)
            for mcc in script_mccs:
                try:
                    sheet_service.sync_mcc_from_sheet(mcc)
                except Exception as e:
                    logger.error("脚本模式 MCC %s Sheet 同步失败: %s", mcc.mcc_name, e)
                time.sleep(2)
            logger.info("脚本模式 MCC 同步完成")

        from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
        sync_service = GoogleAdsServiceAccountSync(db)
        target_date = date.today() - timedelta(days=1)
        force_refresh = True
        logger.info("同步日期: %s (仅昨天)", target_date.isoformat())
        result = sync_service.sync_all_mccs(
            target_date=target_date,
            only_enabled=False,
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



# 拒付佣金检测补跑次数（06:00 首次 + 最多 3 次补跑）
_rejected_check_retry_count = 0
REJECTED_CHECK_MAX_RETRIES = 3


def _run_check_rejected_commission_inner(db: Session, today: date):
    """执行拒付佣金检测核心逻辑（本月日变动 + 上月变动）"""
    from sqlalchemy import and_, or_
    from decimal import Decimal

    month_start = today.replace(day=1)
    yesterday = today - timedelta(days=1)
    last_month_end = month_start - timedelta(days=1)
    last_month_start = last_month_end.replace(day=1)

    # 本月 00:00:00 ~ 昨天 23:59:59
    begin_current = datetime.combine(month_start, datetime.min.time()).replace(tzinfo=BEIJING_TZ)
    end_current = datetime.combine(yesterday, datetime.max.time()).replace(tzinfo=BEIJING_TZ)
    # 上月
    begin_prev = datetime.combine(last_month_start, datetime.min.time()).replace(tzinfo=BEIJING_TZ)
    end_prev = datetime.combine(last_month_end, datetime.max.time()).replace(tzinfo=BEIJING_TZ)

    period_current = today.strftime("%Y-%m")
    period_prev = last_month_start.strftime("%Y-%m")
    threshold = float(getattr(settings, "REJECTED_COMMISSION_DAILY_THRESHOLD", 100.0))

    # 有 user_id 或可通过 affiliate_account 关联到 user 的用户
    users_with_id = db.query(User.id).filter(User.id.isnot(None)).all()
    user_ids = [r[0] for r in users_with_id]

    for uid in user_ids:
        try:
            # 规则 A：本月日变动
            sum_current = (
                db.query(func.coalesce(func.sum(AffiliateTransaction.commission_amount), 0))
                .filter(
                    AffiliateTransaction.status == "rejected",
                    AffiliateTransaction.transaction_time >= begin_current,
                    AffiliateTransaction.transaction_time <= end_current,
                    or_(
                        AffiliateTransaction.user_id == uid,
                        and_(
                            AffiliateTransaction.affiliate_account_id.isnot(None),
                            AffiliateTransaction.affiliate_account_id.in_(
                                db.query(AffiliateAccount.id).filter(AffiliateAccount.user_id == uid)
                            ),
                        ),
                    ),
                )
                .scalar()
            )
            total_current = float(sum_current) if sum_current is not None else 0.0

            snap_current = (
                db.query(CommissionSnapshot)
                .filter(
                    CommissionSnapshot.user_id == uid,
                    CommissionSnapshot.snapshot_type == "current_month",
                    CommissionSnapshot.period == period_current,
                )
                .order_by(CommissionSnapshot.checked_at.desc())
                .first()
            )
            prev_snap_total = float(snap_current.total_rejected) if snap_current else 0.0
            diff = total_current - prev_snap_total

            if diff > threshold:
                title = "本月拒付佣金异常"
                content = f"本月拒付佣金日增 ${diff:.2f}（从 ${prev_snap_total:.2f} 增至 ${total_current:.2f}），超过 ${threshold:.0f} 阈值"
                notif = Notification(
                    user_id=uid,
                    type="rejected_daily",
                    title=title,
                    content=content,
                    is_read=False,
                )
                db.add(notif)
            # 更新/插入本月快照
            if snap_current:
                snap_current.total_rejected = Decimal(str(total_current))
                snap_current.checked_at = datetime.now(BEIJING_TZ)
            else:
                snap_current = CommissionSnapshot(
                    user_id=uid,
                    snapshot_type="current_month",
                    period=period_current,
                    total_rejected=Decimal(str(total_current)),
                )
                db.add(snap_current)

            # 规则 B：上月变动
            sum_prev = (
                db.query(func.coalesce(func.sum(AffiliateTransaction.commission_amount), 0))
                .filter(
                    AffiliateTransaction.status == "rejected",
                    AffiliateTransaction.transaction_time >= begin_prev,
                    AffiliateTransaction.transaction_time <= end_prev,
                    or_(
                        AffiliateTransaction.user_id == uid,
                        and_(
                            AffiliateTransaction.affiliate_account_id.isnot(None),
                            AffiliateTransaction.affiliate_account_id.in_(
                                db.query(AffiliateAccount.id).filter(AffiliateAccount.user_id == uid)
                            ),
                        ),
                    ),
                )
                .scalar()
            )
            total_prev = float(sum_prev) if sum_prev is not None else 0.0

            snap_prev = (
                db.query(CommissionSnapshot)
                .filter(
                    CommissionSnapshot.user_id == uid,
                    CommissionSnapshot.snapshot_type == "previous_month",
                    CommissionSnapshot.period == period_prev,
                )
                .order_by(CommissionSnapshot.checked_at.desc())
                .first()
            )
            old_prev = float(snap_prev.total_rejected) if snap_prev else None

            if old_prev is not None and abs(total_prev - old_prev) < 1e-2:
                # 无变化，不操作
                pass
            elif old_prev is not None:
                # 有变动，生成通知并更新快照
                month_name = last_month_start.strftime("%Y年%m月").replace("年0", "年").replace("月0", "月")
                title = "上月拒付佣金变动"
                content = f"{month_name}拒付佣金从 ${old_prev:.2f} 增至 ${total_prev:.2f}（变动 ${total_prev - old_prev:+.2f}）"
                notif = Notification(
                    user_id=uid,
                    type="rejected_monthly",
                    title=title,
                    content=content,
                    is_read=False,
                )
                db.add(notif)
                if snap_prev:
                    snap_prev.total_rejected = Decimal(str(total_prev))
                    snap_prev.checked_at = datetime.now(BEIJING_TZ)
                else:
                    db.add(
                        CommissionSnapshot(
                            user_id=uid,
                            snapshot_type="previous_month",
                            period=period_prev,
                            total_rejected=Decimal(str(total_prev)),
                        )
                    )
            elif old_prev is None and total_prev > 0:
                # 首次记录上月快照，便于下次比较
                db.add(
                    CommissionSnapshot(
                        user_id=uid,
                        snapshot_type="previous_month",
                        period=period_prev,
                        total_rejected=Decimal(str(total_prev)),
                    )
                )
        except Exception as e:
            logger.exception("拒付检测用户 %s 异常: %s", uid, e)
    db.commit()

    # G-03: NULL user_id 交易汇总并通知 manager
    try:
        from sqlalchemy import and_, or_
        from decimal import Decimal as _Dec

        null_uid_sum = (
            db.query(func.coalesce(func.sum(AffiliateTransaction.commission_amount), 0))
            .filter(
                AffiliateTransaction.status == "rejected",
                AffiliateTransaction.transaction_time >= begin_current,
                AffiliateTransaction.transaction_time <= end_current,
                AffiliateTransaction.user_id.is_(None),
                or_(
                    AffiliateTransaction.affiliate_account_id.is_(None),
                    ~AffiliateTransaction.affiliate_account_id.in_(
                        db.query(AffiliateAccount.id).filter(AffiliateAccount.user_id.isnot(None))
                    ),
                ),
            )
            .scalar()
        )
        null_total = float(null_uid_sum) if null_uid_sum else 0.0

        if null_total > 0:
            managers = db.query(User).filter(User.role == "manager").all()
            for mgr in managers:
                notif = Notification(
                    user_id=mgr.id,
                    type="rejected_unassigned",
                    title="未分配交易拒付佣金汇总",
                    content=f"本月有 ${null_total:.2f} 拒付佣金来自未分配用户的交易，请关注",
                    is_read=False,
                )
                db.add(notif)
            db.commit()
            logger.info("[拒付检测] 未分配交易拒付佣金 $%.2f，已通知 %d 位 manager", null_total, len(managers))
    except Exception as e:
        logger.exception("拒付检测 NULL user_id 汇总异常: %s", e)


def check_rejected_commission_job():
    """
    每天 06:00 拒付佣金变动检测（OPT-002）。
    前置检查：若 backfill 仍在运行（_sync_lock 被占用）则跳过并触发补跑（06:30/07:00/07:30，最多 3 次）。
    任务本身在 _sync_lock 内执行，避免与 backfill 并发写库。
    """
    global _rejected_check_retry_count
    if not _sync_lock.acquire(blocking=False):
        run_at = [
            datetime.now(BEIJING_TZ) + timedelta(minutes=30),
            datetime.now(BEIJING_TZ) + timedelta(minutes=60),
            datetime.now(BEIJING_TZ) + timedelta(minutes=90),
        ]
        if _rejected_check_retry_count < REJECTED_CHECK_MAX_RETRIES:
            next_time = run_at[_rejected_check_retry_count]
            _rejected_check_retry_count += 1
            scheduler.add_job(
                check_rejected_commission_job,
                trigger="date",
                run_date=next_time,
                id=f"rejected_commission_retry_{next_time.strftime('%H%M')}",
                replace_existing=True,
            )
            logger.warning("拒付佣金检测：backfill/同步仍在运行，跳过本次，已调度 %s 补跑", next_time.strftime("%H:%M"))
        else:
            logger.warning("拒付佣金检测：连续 %d 次补跑均因 backfill 未完成而跳过，放弃本日检测", REJECTED_CHECK_MAX_RETRIES + 1)
            _rejected_check_retry_count = 0
        return
    _rejected_check_retry_count = 0
    db = SessionLocal()
    try:
        logger.info("=" * 60)
        logger.info("【拒付佣金变动检测开始】")
        today = date.today()
        _run_check_rejected_commission_inner(db, today)
        logger.info("【拒付佣金变动检测完成】")
        logger.info("=" * 60)
    except Exception as e:
        logger.error("拒付佣金检测任务异常: %s", e, exc_info=True)
    finally:
        db.close()
        _sync_lock.release()


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



def merchant_discover_job():
    """商家自动发现任务（每天北京时间 07:00 执行）：扫描交易表注册新商家"""
    db: Session = SessionLocal()
    try:
        logger.info("=" * 60)
        logger.info("【商家自动发现开始】")
        from app.services.merchant_service import MerchantService
        count = MerchantService.discover_merchants(db)
        logger.info(f"【商家自动发现完成】新增 {count} 个商家")
        logger.info("=" * 60)
    except Exception as e:
        logger.error(f"商家自动发现任务异常: {e}", exc_info=True)
    finally:
        db.close()


def merchant_platform_sync_job():
    """商家平台 API 同步任务（OPT-014：每天只同步 1 个平台，7 天轮换）"""
    db: Session = SessionLocal()
    try:
        logger.info("=" * 60)
        logger.info("【商家平台同步开始（OPT-014 单平台模式）】")
        from app.services.merchant_platform_sync import MerchantPlatformSyncService
        svc = MerchantPlatformSyncService(db)
        result = svc.sync_today_platform()

        if result.get("error"):
            logger.warning("【商家平台同步跳过】平台 %s: %s", result["platform"], result["error"])
        else:
            logger.info(
                "【商家平台同步完成】平台 %s（账号 %s）：新增 %d 商家，API 可见 %d，状态变更 %d，下架 %d",
                result["platform"], result.get("account", "?"),
                result.get("new_merchants", 0),
                result.get("seen_merchants", 0),
                result.get("status_changes", 0),
                result.get("delisted", 0),
            )
        logger.info("=" * 60)
    except Exception as e:
        logger.error(f"商家平台同步任务异常: {e}", exc_info=True)
    finally:
        db.close()


def merchant_mid_repair_job():
    """MID 自动补偿任务（每天北京时间 07:10 执行）：
    按同平台同商家名反查唯一数字MID回填，缺失率 > 1% 时告警 manager (G-08/G-09)
    """
    db: Session = SessionLocal()
    try:
        logger.info("=" * 60)
        logger.info("【MID自动补偿开始】")
        from app.services.merchant_service import MerchantService
        result = MerchantService.auto_repair_mid(db)
        logger.info(f"【MID自动补偿完成】修复 {result['repaired']} 条，失败 {result['failed']} 条")

        # G-09: 缺失率 > 1% 告警 manager
        alerts = []
        for platform, stats in result.get("missing_rate_by_platform", {}).items():
            if stats["rate"] > 1.0:
                alerts.append(f"{platform}: 缺失率 {stats['rate']}% ({stats['missing']}/{stats['total']})")

        if alerts:
            managers = db.query(User).filter(User.role == "manager").all()
            content = "以下平台MID缺失率超过1%:\n" + "\n".join(alerts)
            for mgr in managers:
                notif = Notification(
                    user_id=mgr.id,
                    type="mid_missing_alert",
                    title="MID缺失率告警",
                    content=content,
                    is_read=False,
                )
                db.add(notif)
            db.commit()
            logger.warning("[MID告警] %d 个平台缺失率超标，已通知 %d 位 manager", len(alerts), len(managers))

        logger.info("=" * 60)
    except Exception as e:
        logger.error(f"MID自动补偿任务异常: {e}", exc_info=True)
    finally:
        db.close()


def notification_cleanup_job():
    """通知清理任务（每月1号 01:00 执行）(G-02)：
    - 删除 90 天前的已读通知
    - 将 180 天前的未读通知标记为已读
    """
    db: Session = SessionLocal()
    try:
        logger.info("=" * 60)
        logger.info("【通知清理任务开始】")
        now = datetime.now(BEIJING_TZ)
        cutoff_90d = now - timedelta(days=90)
        cutoff_180d = now - timedelta(days=180)

        deleted = (
            db.query(Notification)
            .filter(
                Notification.is_read == True,
                Notification.created_at < cutoff_90d,
            )
            .delete(synchronize_session=False)
        )

        marked = (
            db.query(Notification)
            .filter(
                Notification.is_read == False,
                Notification.created_at < cutoff_180d,
            )
            .update({"is_read": True}, synchronize_session=False)
        )

        db.commit()
        logger.info("[通知清理] 删除 %d 条90天前已读通知，标记 %d 条180天前未读为已读", deleted, marked)
        logger.info("【通知清理任务完成】")
        logger.info("=" * 60)
    except Exception as e:
        logger.error(f"通知清理任务异常: {e}", exc_info=True)
    finally:
        db.close()


def publish_scheduled_articles_job():
    """文章定时发布检查（OPT-011，每5分钟执行）"""
    db: Session = SessionLocal()
    try:
        from app.models.article import PubArticle
        now = datetime.now()
        articles = db.query(PubArticle).filter(
            PubArticle.status == "draft",
            PubArticle.publish_date.isnot(None),
            PubArticle.publish_date <= now,
            PubArticle.deleted_at.is_(None),
        ).all()
        if articles:
            for article in articles:
                article.status = "published"
                logger.info(f"[定时发布] 文章已发布: {article.title} (ID={article.id})")
            db.commit()
            logger.info(f"[定时发布] 共发布 {len(articles)} 篇文章")
    except Exception as e:
        logger.error(f"文章定时发布检查异常: {e}", exc_info=True)
    finally:
        db.close()


def campaign_link_sync_job():
    """Campaign Link 缓存全量同步（OPT-016，每天 05:00 执行）
    
    遍历所有活跃用户，对每个用户的每个平台全量分页拉取 Joined 商家的 campaign link，
    写入 campaign_link_cache 表。商家数量 2000~8000，需多页遍历。
    """
    db: Session = SessionLocal()
    try:
        logger.info("=" * 60)
        logger.info("【Campaign Link 缓存同步开始（OPT-016）】")
        logger.info(f"当前时间: {datetime.now(BEIJING_TZ).strftime('%Y-%m-%d %H:%M:%S')} (北京时间)")

        from app.services.campaign_link_sync_service import CampaignLinkSyncService
        svc = CampaignLinkSyncService(db)
        result = svc.sync_all_users()

        logger.info("【Campaign Link 缓存同步完成】")
        logger.info(f"  - 用户数: {result['total_users']}")
        logger.info(f"  - 缓存总条数: {result['total_cached']}")
        logger.info(f"  - 失败用户数: {result['total_errors']}")
        logger.info("=" * 60)
    except Exception as e:
        logger.error(f"Campaign Link 缓存同步任务异常: {e}", exc_info=True)
    finally:
        db.close()


def image_cache_cleanup_job():
    """图片缓存清理任务（CR-040，每小时执行）：清理超过 24 小时的过期缓存"""
    try:
        from app.services.image_cache_service import image_cache_service
        max_age = int(getattr(settings, "IMAGE_CACHE_MAX_AGE_HOURS", 24))
        image_cache_service.cleanup_expired(max_age_hours=max_age)
    except Exception as e:
        logger.error(f"图片缓存清理任务异常: {e}", exc_info=True)


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
        
        # 2b. 每天 06:00 - 拒付佣金变动检测（OPT-002）
        scheduler.add_job(
            check_rejected_commission_job,
            trigger=CronTrigger(hour=6, minute=0),
            id='check_rejected_commission',
            name='拒付佣金变动检测（6:00）',
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
        
        # 5. 每天 07:00 - 商家自动发现
        scheduler.add_job(
            merchant_discover_job,
            trigger=CronTrigger(hour=7, minute=0),
            id='merchant_discover',
            name='商家自动发现（7:00）',
            replace_existing=True,
            max_instances=1
        )
        
        # 6. 每天 03:00 - 数据库自动备份（SEC-8）
        scheduler.add_job(
            database_backup_job,
            trigger=CronTrigger(hour=3, minute=0),
            id='database_backup',
            name='数据库自动备份（3:00）',
            replace_existing=True,
            max_instances=1
        )

        # 7. 每天 07:10 - MID自动补偿（G-08/G-09）
        scheduler.add_job(
            merchant_mid_repair_job,
            trigger=CronTrigger(hour=7, minute=10),
            id='merchant_mid_repair',
            name='MID自动补偿（7:10）',
            replace_existing=True,
            max_instances=1
        )

        # 8. 每月1号 01:00 - 通知清理（G-02）
        scheduler.add_job(
            notification_cleanup_job,
            trigger=CronTrigger(day=1, hour=1, minute=0),
            id='notification_cleanup',
            name='通知清理（每月1号 1:00）',
            replace_existing=True,
            max_instances=1
        )

        # 9. 每天 06:30 - 商家平台 API 同步（M-018-A：提前到交易发现 07:00 前，API 数据优先入库）
        scheduler.add_job(
            merchant_platform_sync_job,
            trigger=CronTrigger(hour=6, minute=30),
            id='merchant_platform_sync',
            name='商家平台API同步（06:30）',
            replace_existing=True,
            max_instances=1
        )

        # 10. 每5分钟 - 文章定时发布检查（OPT-011）
        scheduler.add_job(
            publish_scheduled_articles_job,
            trigger='interval',
            minutes=5,
            id='auto_publish_articles',
            name='文章定时发布检查（每5分钟）',
            replace_existing=True,
            max_instances=1
        )

        # 11. 每天 05:00 - Campaign Link 缓存全量同步（OPT-016）
        scheduler.add_job(
            campaign_link_sync_job,
            trigger=CronTrigger(hour=5, minute=0),
            id='campaign_link_sync',
            name='Campaign Link缓存同步（05:00）',
            replace_existing=True,
            max_instances=1
        )

        # 12. 每小时 - 图片缓存清理（CR-040）
        scheduler.add_job(
            image_cache_cleanup_job,
            trigger='interval',
            hours=1,
            id='image_cache_cleanup',
            name='图片缓存清理（每小时）',
            replace_existing=True,
            max_instances=1
        )

        scheduler.start()
        logger.info("=" * 60)
        logger.info("定时任务调度器已启动")
        logger.info("已注册任务:")
        logger.info("  1. 每日自动同步与分析: 每天 04:00")
        logger.info("     (Google Ads昨日 + 平台数据5天 + 周一90天佣金 + 分析 + L7D)")
        logger.info("  (已删除: 历史数据自动补齐 05:00)")
        logger.info("  2b. 拒付佣金变动检测: 每天 06:00")
        logger.info("  3. 平台数据补充同步: 每天 16:00")
        logger.info("  4. 已付佣金同步: 每月1/15号 00:00")
        logger.info("  5. 商家自动发现: 每天 07:00")
        logger.info("  6. 数据库自动备份: 每天 03:00")
        logger.info("  7. MID自动补偿: 每天 07:10")
        logger.info("  8. 通知清理: 每月1号 01:00")
        logger.info("  9. 商家平台API同步: 每天 06:30 (M-018-A)")
        logger.info("  10. 文章定时发布: 每5分钟 (OPT-011)")
        logger.info("  11. Campaign Link缓存同步: 每天 05:00 (OPT-016)")
        logger.info("  12. 图片缓存清理: 每小时 (CR-040)")
        logger.info("=" * 60)
        
    except Exception as e:
        logger.error(f"启动定时任务调度器失败: {e}")


def shutdown_scheduler():
    """关闭定时任务调度器"""
    if scheduler.running:
        scheduler.shutdown()
        logger.info("定时任务调度器已关闭")

