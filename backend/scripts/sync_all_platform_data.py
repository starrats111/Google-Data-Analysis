#!/usr/bin/env python3
"""
一键同步所有平台数据脚本
同步所有用户的所有联盟账号数据，从2026-01-01至今天

使用方法:
    cd ~/Google-Data-Analysis/backend
    source venv/bin/activate
    python scripts/sync_all_platform_data.py
"""

import sys
import os
from datetime import date, timedelta
import logging

# 添加项目根目录到路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal
from app.models.affiliate_account import AffiliateAccount
from app.services.platform_data_sync import PlatformDataSyncService

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def sync_all_platform_data():
    """同步所有用户的所有平台账号数据"""
    
    db = SessionLocal()
    
    try:
        logger.info("=" * 60)
        logger.info("【一键同步所有平台数据】")
        logger.info("=" * 60)
        
        # 同步范围：2026-01-01 至 今天
        begin_date = date(2026, 1, 1)
        end_date = date.today()
        
        logger.info(f"同步日期范围: {begin_date.isoformat()} ~ {end_date.isoformat()}")
        
        # 获取所有活跃的联盟账号
        active_accounts = db.query(AffiliateAccount).filter(
            AffiliateAccount.is_active == True
        ).all()
        
        logger.info(f"找到 {len(active_accounts)} 个活跃账号")
        
        sync_service = PlatformDataSyncService(db)
        
        total_success_count = 0
        total_fail_count = 0
        total_saved = 0
        
        # 逐天同步
        current_date = begin_date
        day_count = 0
        total_days = (end_date - begin_date).days + 1
        
        while current_date <= end_date:
            day_count += 1
            logger.info("-" * 60)
            logger.info(f"正在同步日期: {current_date.isoformat()} ({day_count}/{total_days})")
            
            day_success_count = 0
            day_fail_count = 0
            day_saved = 0
            
            for account in active_accounts:
                try:
                    platform_name = account.platform.platform_name if account.platform else '未知'
                    logger.info(f"  同步账号: {account.account_name} (平台: {platform_name})")
                    
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
        logger.info("【同步完成】")
        logger.info(f"  - 同步日期数: {total_days} 天")
        logger.info(f"  - 总成功次数: {total_success_count} 次")
        logger.info(f"  - 总失败次数: {total_fail_count} 次")
        logger.info(f"  - 共保存: {total_saved} 条记录")
        logger.info("=" * 60)
        
    except Exception as e:
        logger.error(f"✗ 同步异常: {e}", exc_info=True)
    finally:
        db.close()


if __name__ == "__main__":
    sync_all_platform_data()
