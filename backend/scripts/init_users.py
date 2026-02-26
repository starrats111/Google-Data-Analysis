"""
初始化用户数据
"""
import sys
import os

# 添加项目根目录到 Python 路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy.orm import Session
from app.database import SessionLocal
from app.models.user import User, UserRole
from app.middleware.auth import get_password_hash

def init_users():
    """创建初始用户（1个经理 + 10个员工）"""
    db = SessionLocal()
    
    try:
        # 创建或更新经理账户
        manager = db.query(User).filter(User.username == "manager").first()
        if manager:
            # 更新现有经理密码
            manager.password_hash = get_password_hash("wj123456")
            print("更新经理账户密码：manager")
        else:
            # 创建新经理账户
            manager = User(
                username="manager",
                password_hash=get_password_hash("wj123456"),
                role=UserRole.MANAGER,
                employee_id=None
            )
            db.add(manager)
            print("创建经理账户：manager")
        
        # 创建或更新10个员工账户
        for i in range(1, 11):
            username = f"wj{i:02d}"  # wj01, wj02, ..., wj10
            employee = db.query(User).filter(User.username == username).first()
            if employee:
                # 更新现有员工密码
                employee.password_hash = get_password_hash("wj123456")
                print(f"更新员工账户密码：{username}")
            else:
                # 创建新员工账户
                employee = User(
                    username=username,
                    password_hash=get_password_hash("wj123456"),
                    role=UserRole.EMPLOYEE,
                    employee_id=i
                )
                db.add(employee)
                print(f"创建员工账户：{username} / wj123456")
        
        db.commit()
        print("\n用户初始化完成！")
        print("⚠️  请立即修改默认密码！")
        
    except Exception as e:
        db.rollback()
        print(f"初始化失败：{e}")
    finally:
        db.close()

if __name__ == "__main__":
    init_users()

