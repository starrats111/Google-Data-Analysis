#!/usr/bin/env python3
"""
数据库迁移脚本：创建affiliate_transactions和affiliate_rejections表
"""
import sys
import os

# 添加项目根目录到路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import create_engine, text
from app.database import get_database_url
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def migrate():
    """执行数据库迁移"""
    database_url = get_database_url()
    engine = create_engine(database_url)
    
    with engine.connect() as conn:
        # 开始事务
        trans = conn.begin()
        
        try:
            # 检查表是否已存在
            result = conn.execute(text("""
                SELECT name FROM sqlite_master 
                WHERE type='table' AND name='affiliate_transactions'
            """))
            
            if result.fetchone():
                logger.info("✅ affiliate_transactions 表已存在，跳过创建")
            else:
                # 创建affiliate_transactions表
                logger.info("创建 affiliate_transactions 表...")
                conn.execute(text("""
                    CREATE TABLE affiliate_transactions (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        platform VARCHAR(32) NOT NULL,
                        merchant VARCHAR(128),
                        transaction_id VARCHAR(128) NOT NULL,
                        transaction_time TIMESTAMP NOT NULL,
                        order_amount DECIMAL(12,2) DEFAULT 0 NOT NULL,
                        commission_amount DECIMAL(12,2) DEFAULT 0 NOT NULL,
                        currency VARCHAR(8) DEFAULT 'USD' NOT NULL,
                        status VARCHAR(16) NOT NULL,
                        raw_status VARCHAR(32),
                        affiliate_account_id INTEGER,
                        user_id INTEGER,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP
                    )
                """))
                
                # 创建索引
                logger.info("创建索引...")
                conn.execute(text("""
                    CREATE UNIQUE INDEX uq_affiliate_transaction_platform_txid 
                    ON affiliate_transactions(platform, transaction_id)
                """))
                conn.execute(text("""
                    CREATE INDEX idx_affiliate_transaction_platform_time 
                    ON affiliate_transactions(platform, transaction_time)
                """))
                conn.execute(text("""
                    CREATE INDEX idx_affiliate_transaction_status_time 
                    ON affiliate_transactions(status, transaction_time)
                """))
                conn.execute(text("""
                    CREATE INDEX idx_affiliate_transaction_user_time 
                    ON affiliate_transactions(user_id, transaction_time)
                """))
                conn.execute(text("""
                    CREATE INDEX idx_affiliate_transaction_platform 
                    ON affiliate_transactions(platform)
                """))
                conn.execute(text("""
                    CREATE INDEX idx_affiliate_transaction_merchant 
                    ON affiliate_transactions(merchant)
                """))
                
                logger.info("✅ affiliate_transactions 表创建成功")
            
            # 检查rejections表是否已存在
            result = conn.execute(text("""
                SELECT name FROM sqlite_master 
                WHERE type='table' AND name='affiliate_rejections'
            """))
            
            if result.fetchone():
                logger.info("✅ affiliate_rejections 表已存在，跳过创建")
            else:
                # 创建affiliate_rejections表
                logger.info("创建 affiliate_rejections 表...")
                conn.execute(text("""
                    CREATE TABLE affiliate_rejections (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        platform VARCHAR(32) NOT NULL,
                        transaction_id VARCHAR(128) NOT NULL,
                        commission_amount DECIMAL(12,2) DEFAULT 0 NOT NULL,
                        reject_reason TEXT,
                        reject_time TIMESTAMP,
                        raw_payload TEXT,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """))
                
                # 创建索引
                logger.info("创建索引...")
                conn.execute(text("""
                    CREATE UNIQUE INDEX uq_affiliate_rejection_platform_txid 
                    ON affiliate_rejections(platform, transaction_id)
                """))
                conn.execute(text("""
                    CREATE INDEX idx_affiliate_rejection_time 
                    ON affiliate_rejections(reject_time)
                """))
                conn.execute(text("""
                    CREATE INDEX idx_affiliate_rejection_platform 
                    ON affiliate_rejections(platform)
                """))
                conn.execute(text("""
                    CREATE INDEX idx_affiliate_rejection_transaction_id 
                    ON affiliate_rejections(transaction_id)
                """))
                
                logger.info("✅ affiliate_rejections 表创建成功")
            
            # 提交事务
            trans.commit()
            logger.info("✅ 数据库迁移完成")
            return True
            
        except Exception as e:
            trans.rollback()
            logger.error(f"❌ 数据库迁移失败: {e}")
            import traceback
            traceback.print_exc()
            return False


if __name__ == "__main__":
    success = migrate()
    sys.exit(0 if success else 1)

