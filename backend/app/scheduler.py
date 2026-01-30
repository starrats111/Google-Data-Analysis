"""
定时任务调度器
使用APScheduler执行定时任务
"""
import logging
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from app.services.scheduler_service import SchedulerService

logger = logging.getLogger(__name__)

# 创建调度器
scheduler = BackgroundScheduler()

def start_scheduler():
    """启动定时任务"""
    # 每天4点同步平台数据
    scheduler.add_job(
        SchedulerService.sync_platform_data,
        trigger=CronTrigger(hour=4, minute=0),
        id='sync_platform_data_4am',
        name='同步平台数据（4点）',
        replace_existing=True
    )
    
    # 每天16点同步平台数据
    scheduler.add_job(
        SchedulerService.sync_platform_data,
        trigger=CronTrigger(hour=16, minute=0),
        id='sync_platform_data_4pm',
        name='同步平台数据（16点）',
        replace_existing=True
    )
    
    # 每天8点同步Google Ads数据
    scheduler.add_job(
        SchedulerService.sync_google_ads_data,
        trigger=CronTrigger(hour=8, minute=0),
        id='sync_google_ads_data',
        name='同步Google Ads数据',
        replace_existing=True
    )
    
    # 每天8点执行每日分析（在同步数据之后，延迟5分钟）
    scheduler.add_job(
        SchedulerService.run_daily_analysis,
        trigger=CronTrigger(hour=8, minute=5),
        id='run_daily_analysis',
        name='执行每日分析',
        replace_existing=True
    )
    
    scheduler.start()
    logger.info("定时任务调度器已启动")

def shutdown_scheduler():
    """关闭定时任务"""
    scheduler.shutdown()
    logger.info("定时任务调度器已关闭")

