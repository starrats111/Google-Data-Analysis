#!/usr/bin/env python3
"""
数据库迁移脚本：为platform_data表添加拒付相关字段

新增字段：
- approved_orders: 已确认订单数
- rejected_orders: 拒付订单数
- rejected_commission: 拒付佣金
- order_amount: 订单总金额
"""
import sys
import os

# 添加项目根目录到路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import create_engine, text
from app.config import settings
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def migrate():
    """执行数据库迁移"""
    database_url = settings.DATABASE_URL
    # SQLite需要特殊处理
    if database_url.startswith("sqlite"):
        engine = create_engine(database_url, connect_args={"check_same_thread": False})
    else:
        engine = create_engine(database_url)
    
    with engine.connect() as conn:
        # 开始事务
        trans = conn.begin()
        
        try:
            # 检查字段是否已存在
            result = conn.execute(text("""
                SELECT sql FROM sqlite_master 
                WHERE type='table' AND name='platform_data'
            """))
            table_sql = result.fetchone()
            
            if table_sql:
                table_sql_str = table_sql[0]
                logger.info("当前表结构已存在")
                
                # 检查并添加新字段
                fields_to_add = []
                
                if 'approved_orders' not in table_sql_str:
                    fields_to_add.append(('approved_orders', 'INTEGER DEFAULT 0 NOT NULL'))
                
                if 'rejected_orders' not in table_sql_str:
                    fields_to_add.append(('rejected_orders', 'INTEGER DEFAULT 0 NOT NULL'))
                
                if 'rejected_commission' not in table_sql_str:
                    fields_to_add.append(('rejected_commission', 'REAL DEFAULT 0.0 NOT NULL'))
                
                if 'order_amount' not in table_sql_str:
                    fields_to_add.append(('order_amount', 'REAL DEFAULT 0.0 NOT NULL'))
                
                if fields_to_add:
                    logger.info(f"需要添加 {len(fields_to_add)} 个字段")
                    
                    for field_name, field_type in fields_to_add:
                        logger.info(f"添加字段: {field_name} {field_type}")
                        conn.execute(text(f"ALTER TABLE platform_data ADD COLUMN {field_name} {field_type}"))
                    
                    logger.info("✅ 所有字段添加成功")
                else:
                    logger.info("✅ 所有字段已存在，无需迁移")
            else:
                logger.error("❌ 找不到platform_data表")
                trans.rollback()
                return False
            
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

