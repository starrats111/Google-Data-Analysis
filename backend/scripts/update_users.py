"""
更新用户：删除旧用户，保留新用户
"""
import sys
import os

# 添加项目根目录到 Python 路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy.orm import Session
from app.database import SessionLocal
from app.models.user import User, UserRole
from app.middleware.auth import get_password_hash

def update_users():
    """更新用户：删除旧用户，更新新用户密码"""
    db = SessionLocal()
    
    try:
        # 删除旧的经理账户
        old_manager = db.query(User).filter(User.username == "manager").first()
        if old_manager:
            db.delete(old_manager)
            print("删除旧经理账户：manager")
        
        # 删除旧的员工账户
        for i in range(1, 11):
            old_employee = db.query(User).filter(User.username == f"employee{i}").first()
            if old_employee:
                db.delete(old_employee)
                print(f"删除旧员工账户：employee{i}")
        
        # 确保新经理账户存在且密码正确
        manager = db.query(User).filter(User.username == "wenjun123").first()
        if manager:
            manager.password_hash = get_password_hash("wj123456")
            print("更新经理账户密码：wenjun123")
        else:
            manager = User(
                username="wenjun123",
                password_hash=get_password_hash("wj123456"),
                role=UserRole.MANAGER,
                employee_id=None
            )
            db.add(manager)
            print("创建经理账户：wenjun123")
        
        # 确保新员工账户存在且密码正确
        for i in range(1, 11):
            username = f"wj{i:02d}"
            employee = db.query(User).filter(User.username == username).first()
            if employee:
                employee.password_hash = get_password_hash("wj123456")
                print(f"更新员工账户密码：{username}")
            else:
                employee = User(
                    username=username,
                    password_hash=get_password_hash("wj123456"),
                    role=UserRole.EMPLOYEE,
                    employee_id=i
                )
                db.add(employee)
                print(f"创建员工账户：{username}")
        
        db.commit()
        print("\n用户更新完成！")
        
    except Exception as e:
        db.rollback()
        print(f"更新失败：{e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()

if __name__ == "__main__":
    update_users()






