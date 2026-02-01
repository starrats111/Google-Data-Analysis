"""
迁移用户：将旧用户的数据迁移到新用户，然后更新密码
"""
import sys
import os

# 添加项目根目录到 Python 路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy.orm import Session
from app.database import SessionLocal
from app.models.user import User, UserRole
from app.models.data_upload import DataUpload
from app.models.analysis_result import AnalysisResult
from app.models.affiliate_account import AffiliateAccount
from app.middleware.auth import get_password_hash

def migrate_users():
    """迁移用户数据"""
    db = SessionLocal()
    
    try:
        # 获取新用户
        new_manager = db.query(User).filter(User.username == "wenjun123").first()
        if not new_manager:
            new_manager = User(
                username="wenjun123",
                password_hash=get_password_hash("wj123456"),
                role=UserRole.MANAGER,
                employee_id=None
            )
            db.add(new_manager)
            db.flush()
            print("创建新经理账户：wenjun123")
        
        # 创建新员工账户映射
        employee_mapping = {}
        for i in range(1, 11):
            new_username = f"wj{i:02d}"
            old_username = f"employee{i}"
            
            new_employee = db.query(User).filter(User.username == new_username).first()
            if not new_employee:
                new_employee = User(
                    username=new_username,
                    password_hash=get_password_hash("wj123456"),
                    role=UserRole.EMPLOYEE,
                    employee_id=i
                )
                db.add(new_employee)
                db.flush()
                print(f"创建新员工账户：{new_username}")
            
            old_employee = db.query(User).filter(User.username == old_username).first()
            if old_employee:
                employee_mapping[old_employee.id] = new_employee.id
        
        # 迁移旧经理的数据到新经理
        old_manager = db.query(User).filter(User.username == "manager").first()
        if old_manager and old_manager.id != new_manager.id:
            # 迁移数据上传
            db.query(DataUpload).filter(DataUpload.user_id == old_manager.id).update({
                DataUpload.user_id: new_manager.id
            })
            # 迁移分析结果
            db.query(AnalysisResult).filter(AnalysisResult.user_id == old_manager.id).update({
                AnalysisResult.user_id: new_manager.id
            })
            # 迁移联盟账号
            db.query(AffiliateAccount).filter(AffiliateAccount.user_id == old_manager.id).update({
                AffiliateAccount.user_id: new_manager.id
            })
            print(f"迁移经理数据：manager -> wenjun123")
        
        # 迁移旧员工的数据到新员工
        for old_id, new_id in employee_mapping.items():
            # 迁移数据上传
            db.query(DataUpload).filter(DataUpload.user_id == old_id).update({
                DataUpload.user_id: new_id
            })
            # 迁移分析结果
            db.query(AnalysisResult).filter(AnalysisResult.user_id == old_id).update({
                AnalysisResult.user_id: new_id
            })
            # 迁移联盟账号
            db.query(AffiliateAccount).filter(AffiliateAccount.user_id == old_id).update({
                AffiliateAccount.user_id: new_id
            })
            old_user = db.query(User).filter(User.id == old_id).first()
            new_user = db.query(User).filter(User.id == new_id).first()
            print(f"迁移员工数据：{old_user.username} -> {new_user.username}")
        
        # 删除旧用户
        if old_manager and old_manager.id != new_manager.id:
            db.delete(old_manager)
            print("删除旧经理账户：manager")
        
        for old_id in employee_mapping.keys():
            old_user = db.query(User).filter(User.id == old_id).first()
            if old_user:
                db.delete(old_user)
                print(f"删除旧员工账户：{old_user.username}")
        
        # 确保所有新用户密码正确
        new_manager.password_hash = get_password_hash("wj123456")
        for i in range(1, 11):
            username = f"wj{i:02d}"
            employee = db.query(User).filter(User.username == username).first()
            if employee:
                employee.password_hash = get_password_hash("wj123456")
        
        db.commit()
        print("\n用户迁移完成！")
        
    except Exception as e:
        db.rollback()
        print(f"迁移失败：{e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()

if __name__ == "__main__":
    migrate_users()











