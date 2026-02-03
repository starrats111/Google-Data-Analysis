"""
迁移平台代码：将旧的缩写代码更新为标准完整代码
- 'pm' -> 'partnermatic'
- 'cf' -> 'creatorflare'
- 'lb' -> 'linkbux'
- 'pb' -> 'partnerboost'

这个脚本用于修复平台代码不一致的问题
"""
import sys
import os

# 添加项目根目录到路径
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.database import SessionLocal
from app.models.affiliate_transaction import AffiliateTransaction
from app.models.platform_data import PlatformData
from sqlalchemy import text
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 平台代码映射
PLATFORM_CODE_MAP = {
    'pm': 'partnermatic',
    'cf': 'creatorflare',
    'lb': 'linkbux',
    'pb': 'partnerboost',
}


def migrate_affiliate_transactions(db):
    """迁移AffiliateTransaction表中的平台代码"""
    logger.info("开始迁移AffiliateTransaction表中的平台代码...")
    
    updated_count = 0
    for old_code, new_code in PLATFORM_CODE_MAP.items():
        # 统计需要更新的记录数
        count = db.query(AffiliateTransaction).filter(
            AffiliateTransaction.platform == old_code
        ).count()
        
        if count > 0:
            logger.info(f"找到 {count} 条使用 '{old_code}' 的记录，将更新为 '{new_code}'")
            
            # 更新记录
            result = db.execute(
                text("UPDATE affiliate_transactions SET platform = :new_code WHERE platform = :old_code"),
                {"new_code": new_code, "old_code": old_code}
            )
            updated_count += result.rowcount
            logger.info(f"已更新 {result.rowcount} 条记录: '{old_code}' -> '{new_code}'")
        else:
            logger.info(f"未找到使用 '{old_code}' 的记录，跳过")
    
    db.commit()
    logger.info(f"✓ AffiliateTransaction表迁移完成，共更新 {updated_count} 条记录")
    return updated_count


def migrate_platform_data(db):
    """迁移PlatformData表中的平台代码"""
    logger.info("开始迁移PlatformData表中的平台代码...")
    
    updated_count = 0
    for old_code, new_code in PLATFORM_CODE_MAP.items():
        # 统计需要更新的记录数
        count = db.query(PlatformData).filter(
            PlatformData.platform == old_code
        ).count()
        
        if count > 0:
            logger.info(f"找到 {count} 条使用 '{old_code}' 的记录，将更新为 '{new_code}'")
            
            # 更新记录
            result = db.execute(
                text("UPDATE platform_data SET platform = :new_code WHERE platform = :old_code"),
                {"new_code": new_code, "old_code": old_code}
            )
            updated_count += result.rowcount
            logger.info(f"已更新 {result.rowcount} 条记录: '{old_code}' -> '{new_code}'")
        else:
            logger.info(f"未找到使用 '{old_code}' 的记录，跳过")
    
    db.commit()
    logger.info(f"✓ PlatformData表迁移完成，共更新 {updated_count} 条记录")
    return updated_count


def main():
    """主函数"""
    db = SessionLocal()
    try:
        logger.info("=" * 60)
        logger.info("开始迁移平台代码...")
        logger.info("=" * 60)
        
        # 迁移AffiliateTransaction表
        tx_count = migrate_affiliate_transactions(db)
        
        # 迁移PlatformData表
        pd_count = migrate_platform_data(db)
        
        logger.info("=" * 60)
        logger.info("迁移完成！")
        logger.info(f"AffiliateTransaction表: 更新 {tx_count} 条记录")
        logger.info(f"PlatformData表: 更新 {pd_count} 条记录")
        logger.info("=" * 60)
        
    except Exception as e:
        db.rollback()
        logger.error(f"迁移失败: {e}", exc_info=True)
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()

