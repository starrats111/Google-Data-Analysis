"""
添加MCC货币字段的数据库迁移脚本
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text
from app.database import engine, SessionLocal

def migrate():
    """添加currency字段到google_mcc_accounts表"""
    db = SessionLocal()
    
    try:
        # 检查字段是否已存在
        result = db.execute(text("PRAGMA table_info(google_mcc_accounts)"))
        columns = [row[1] for row in result.fetchall()]
        
        if 'currency' not in columns:
            print("添加 currency 字段...")
            db.execute(text("ALTER TABLE google_mcc_accounts ADD COLUMN currency VARCHAR(10) DEFAULT 'USD' NOT NULL"))
            db.commit()
            print("✅ currency 字段添加成功")
        else:
            print("✅ currency 字段已存在")
        
        # 显示当前MCC账号的货币设置
        result = db.execute(text("SELECT id, mcc_id, user_id, currency FROM google_mcc_accounts"))
        print("\n当前MCC账号货币设置:")
        for row in result.fetchall():
            print(f"  ID={row[0]}, MCC={row[1]}, user_id={row[2]}, currency={row[3]}")
        
    except Exception as e:
        print(f"❌ 迁移失败: {e}")
        db.rollback()
        return False
    finally:
        db.close()
    
    return True


def set_mcc_currency(mcc_id: str, currency: str):
    """设置指定MCC的货币"""
    db = SessionLocal()
    try:
        db.execute(
            text("UPDATE google_mcc_accounts SET currency = :currency WHERE mcc_id = :mcc_id"),
            {"currency": currency, "mcc_id": mcc_id}
        )
        db.commit()
        print(f"✅ MCC {mcc_id} 货币设置为 {currency}")
    except Exception as e:
        print(f"❌ 设置失败: {e}")
        db.rollback()
    finally:
        db.close()


if __name__ == "__main__":
    print("=== MCC货币字段迁移 ===\n")
    migrate()
    
    # 使用示例（取消注释并修改参数来设置）:
    # set_mcc_currency("191-217-0158", "CNY")  # 设置为人民币
    # set_mcc_currency("916-831-7343", "USD")  # 设置为美元

