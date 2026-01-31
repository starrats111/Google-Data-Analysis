"""
定时任务调度器
用于执行定时数据同步和分析任务
"""
import logging
import json
from datetime import datetime, time, date, timedelta, timezone

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.services.platform_data_sync import PlatformDataSyncService
from app.services.google_ads_api_sync import GoogleAdsApiSyncService
from app.services.api_analysis_service import ApiAnalysisService
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.google_ads_api_data import GoogleAdsApiData, GoogleMccAccount
from app.models.platform_data import PlatformData

logger = logging.getLogger(__name__)

# 北京时间（UTC+8）
BEIJING_TZ = timezone(timedelta(hours=8))

# 使用北京时间作为调度器的默认时区
scheduler = BackgroundScheduler(timezone=BEIJING_TZ)


def sync_platform_data_job():
    """同步平台数据任务（每天北京时间4点和16点执行）"""
    db: Session = SessionLocal()
    try:
        logger.info("开始执行平台数据同步任务...")
        
        sync_service = PlatformDataSyncService(db)
        
        # 获取所有活跃的联盟账号
        active_accounts = db.query(AffiliateAccount).filter(
            AffiliateAccount.is_active == True
        ).all()
        
        # 同步最近7天的数据（确保覆盖可能变化的佣金）
        end_date = date.today() - timedelta(days=1)  # 昨天
        begin_date = end_date - timedelta(days=6)  # 7天前
        
        success_count = 0
        fail_count = 0
        
        for account in active_accounts:
            try:
                result = sync_service.sync_account_data(
                    account.id,
                    begin_date.isoformat(),
                    end_date.isoformat()
                )
                
                if result.get("success"):
                    success_count += 1
                    logger.info(f"账号 {account.account_name} 同步成功")
                else:
                    fail_count += 1
                    logger.error(f"账号 {account.account_name} 同步失败: {result.get('message')}")
            except Exception as e:
                fail_count += 1
                logger.error(f"账号 {account.account_name} 同步异常: {e}")
        
        logger.info(f"平台数据同步任务完成: 成功 {success_count}, 失败 {fail_count}")
        
    except Exception as e:
        logger.error(f"平台数据同步任务执行失败: {e}")
    finally:
        db.close()


def sync_google_ads_data_job():
    """同步Google Ads数据任务（每天北京时间早上8点执行）"""
    db: Session = SessionLocal()
    try:
        logger.info("开始执行Google Ads数据同步任务...")
        
        sync_service = GoogleAdsApiSyncService(db)
        
        # 同步昨天的数据
        target_date = date.today() - timedelta(days=1)
        
        result = sync_service.sync_all_active_mccs()
        
        if result.get("success"):
            logger.info(f"Google Ads数据同步完成: 共保存 {result.get('total_saved', 0)} 条记录")
        else:
            logger.error(f"Google Ads数据同步失败: {result.get('message')}")
        
    except Exception as e:
        logger.error(f"Google Ads数据同步任务执行失败: {e}")
    finally:
        db.close()


def daily_analysis_job():
    """每日分析任务（每天北京时间早上8点05分执行）"""
    db: Session = SessionLocal()
    try:
        logger.info("开始执行每日分析任务...")
        
        # 分析昨天的数据
        target_date = date.today() - timedelta(days=1)
        
        # 调用API分析服务
        api_analysis_service = ApiAnalysisService(db)
        
        # 为所有用户生成每日分析（user_id=None表示所有用户）
        result = api_analysis_service.generate_daily_analysis(target_date, user_id=None)
        
        if result.get("success"):
            total_records = result.get("total_records", 0)
            logger.info(f"每日分析任务完成: {target_date.isoformat()}, 共生成 {total_records} 条记录")
        else:
            logger.error(f"每日分析任务失败: {result.get('message')}")
        
    except Exception as e:
        logger.error(f"每日分析任务执行失败: {e}", exc_info=True)
    finally:
        db.close()


def weekly_l7d_analysis_job():
    """每周L7D分析任务（每周一/三/五北京时间早上8点10分执行）"""
    db: Session = SessionLocal()
    try:
        logger.info("开始执行每周L7D分析任务...")

        # 结束日期为昨天（不包含今天）
        end_date = date.today() - timedelta(days=1)

        api_analysis_service = ApiAnalysisService(db)

        # 为所有用户生成L7D分析（user_id=None表示所有用户）
        result = api_analysis_service.generate_l7d_analysis(end_date, user_id=None)

        if result.get("success"):
            logger.info(
                "每周L7D分析任务完成: %s 至 %s, 共生成 %s 条记录",
                result.get("begin_date"),
                result.get("end_date"),
                result.get("total_records", 0),
            )
        else:
            logger.error(f"每周L7D分析任务失败: {result.get('message')}")

    except Exception as e:
        logger.error("每周L7D分析任务执行失败: %s", e, exc_info=True)
    finally:
        db.close()


def monthly_summary_job():
    """
    月度总结任务（每月1号北京时间早上8点20分执行）
    统计上月的：
    - 总花费（以及每个MCC的花费）
    - 总佣金（以及每个平台的佣金）
    - 总拒付佣金（以及每个平台的拒付佣金，目前占位为0，后续有字段后再完善）
    """
    db: Session = SessionLocal()
    try:
        logger.info("开始执行月度总结任务...")

        today = date.today()
        # 本月1号
        first_day_this_month = today.replace(day=1)
        # 上月最后一天
        last_day_last_month = first_day_this_month - timedelta(days=1)
        # 上月1号
        first_day_last_month = last_day_last_month.replace(day=1)

        start_date = first_day_last_month
        end_date = last_day_last_month

        # 1. Google Ads总花费和按MCC拆分
        total_cost = (
            db.query(func.coalesce(func.sum(GoogleAdsApiData.cost), 0))
            .filter(
                GoogleAdsApiData.date >= start_date,
                GoogleAdsApiData.date <= end_date,
            )
            .scalar()
            or 0.0
        )

        mcc_cost_rows = (
            db.query(
                GoogleMccAccount.mcc_name,
                func.sum(GoogleAdsApiData.cost),
            )
            .join(GoogleAdsApiData, GoogleAdsApiData.mcc_id == GoogleMccAccount.id)
            .filter(
                GoogleAdsApiData.date >= start_date,
                GoogleAdsApiData.date <= end_date,
            )
            .group_by(GoogleMccAccount.id, GoogleMccAccount.mcc_name)
            .all()
        )

        mcc_cost_details = [
            {
                "mcc_name": mcc_name,
                "cost": float(cost or 0),
            }
            for mcc_name, cost in mcc_cost_rows
        ]

        # 2. 平台总佣金和按平台拆分
        total_commission = (
            db.query(func.coalesce(func.sum(PlatformData.commission), 0))
            .filter(
                PlatformData.date >= start_date,
                PlatformData.date <= end_date,
            )
            .scalar()
            or 0.0
        )

        platform_rows = (
            db.query(
                AffiliatePlatform.platform_name,
                func.sum(PlatformData.commission),
            )
            .join(
                AffiliateAccount,
                AffiliateAccount.id == PlatformData.affiliate_account_id,
            )
            .join(
                AffiliatePlatform,
                AffiliatePlatform.id == AffiliateAccount.platform_id,
            )
            .filter(
                PlatformData.date >= start_date,
                PlatformData.date <= end_date,
            )
            .group_by(AffiliatePlatform.id, AffiliatePlatform.platform_name)
            .all()
        )

        platform_commission_details = [
            {
                "platform_name": platform_name,
                "commission": float(commission or 0),
            }
            for platform_name, commission in platform_rows
        ]

        # 3. 拒付佣金（目前没有单独字段，占位为0，后续有字段后再补充真实计算逻辑）
        total_rejected_commission = 0.0
        platform_rejected_details = []

        summary = {
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "total_cost": float(total_cost),
            "total_commission": float(total_commission),
            "total_rejected_commission": float(total_rejected_commission),
            "mcc_cost_details": mcc_cost_details,
            "platform_commission_details": platform_commission_details,
            "platform_rejected_details": platform_rejected_details,
        }

        # 目前先写入日志，后续如果需要可以存入专门的月度总结表
        logger.info("上月总结结果: %s", json.dumps(summary, ensure_ascii=False))

    except Exception as e:
        logger.error("月度总结任务执行失败: %s", e, exc_info=True)
    finally:
        db.close()


def start_scheduler():
    """启动定时任务调度器"""
    if scheduler.running:
        logger.warning("调度器已在运行")
        return
    
    try:
        # 平台数据同步：每天北京时间4点和16点
        scheduler.add_job(
            sync_platform_data_job,
            trigger=CronTrigger(hour="4,16", minute=0),
            id='sync_platform_data',
            name='同步平台数据',
            replace_existing=True
        )
        
        # Google Ads数据同步：每天北京时间早上8点
        scheduler.add_job(
            sync_google_ads_data_job,
            trigger=CronTrigger(hour=8, minute=0),
            id='sync_google_ads_data',
            name='同步Google Ads数据',
            replace_existing=True
        )
        
        # 每日分析：每天北京时间早上8点05分（在Google Ads数据同步之后）
        scheduler.add_job(
            daily_analysis_job,
            trigger=CronTrigger(hour=8, minute=5),  # 延迟5分钟，确保数据同步完成
            id='daily_analysis',
            name='每日分析',
            replace_existing=True
        )

        # 每周L7D分析：每周一/三/五北京时间早上8点10分
        scheduler.add_job(
            weekly_l7d_analysis_job,
            trigger=CronTrigger(day_of_week="mon,wed,fri", hour=8, minute=10),
            id='weekly_l7d_analysis',
            name='每周L7D分析',
            replace_existing=True
        )

        # 月度总结：每月1号北京时间早上8点20分，统计上月数据
        scheduler.add_job(
            monthly_summary_job,
            trigger=CronTrigger(day=1, hour=8, minute=20),
            id='monthly_summary',
            name='月度总结',
            replace_existing=True
        )
        
        scheduler.start()
        logger.info("定时任务调度器已启动")
        
    except Exception as e:
        logger.error(f"启动定时任务调度器失败: {e}")


def shutdown_scheduler():
    """关闭定时任务调度器"""
    if scheduler.running:
        scheduler.shutdown()
        logger.info("定时任务调度器已关闭")

