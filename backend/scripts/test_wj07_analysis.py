#!/usr/bin/env python3
"""
测试 wj07 用户的每日分析和 L7D 分析
使用过去七天的数据
"""
import sys
from pathlib import Path
from datetime import date, timedelta

# 添加项目根目录到路径
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from app.database import SessionLocal
from app.models.user import User
from app.services.api_analysis_service import ApiAnalysisService

def get_user_id(username: str, db):
    """获取用户ID"""
    user = db.query(User).filter(User.username == username).first()
    if not user:
        return None
    return user.id

def test_daily_analysis(db, user_id):
    """测试每日分析"""
    print("\n" + "="*60)
    print("测试每日分析（过去7天，每天生成一次）")
    print("="*60)
    
    api_service = ApiAnalysisService(db)
    today = date.today()
    
    # 过去7天（包含今天）
    for i in range(7):
        target_date = today - timedelta(days=i)
        print(f"\n生成 {target_date} 的每日分析...")
        
        try:
            result = api_service.generate_daily_analysis(target_date, user_id=user_id)
            
            if result.get("success"):
                total_records = result.get("total_records", 0)
                print(f"  ✓ 成功: 生成 {total_records} 条记录")
            else:
                print(f"  ✗ 失败: {result.get('message', '未知错误')}")
        except Exception as e:
            print(f"  ✗ 异常: {str(e)}")

def test_l7d_analysis(db, user_id):
    """测试 L7D 分析"""
    print("\n" + "="*60)
    print("测试 L7D 分析（过去7天的汇总）")
    print("="*60)
    
    api_service = ApiAnalysisService(db)
    end_date = date.today() - timedelta(days=1)  # 昨天
    
    print(f"\n生成截止到 {end_date} 的 L7D 分析（过去7天）...")
    
    try:
        result = api_service.generate_l7d_analysis(end_date, user_id=user_id)
        
        if result.get("success"):
            total_records = result.get("total_records", 0)
            begin_date = result.get("begin_date")
            end_date_result = result.get("end_date")
            print(f"  ✓ 成功: 生成 {total_records} 条记录")
            print(f"  日期范围: {begin_date} 至 {end_date_result}")
        else:
            print(f"  ✗ 失败: {result.get('message', '未知错误')}")
    except Exception as e:
        print(f"  ✗ 异常: {str(e)}")
        import traceback
        traceback.print_exc()

def main():
    db = SessionLocal()
    try:
        # 获取 wj07 用户ID
        username = "wj07"
        user_id = get_user_id(username, db)
        
        if not user_id:
            print(f"✗ 用户 {username} 不存在")
            return
        
        user = db.query(User).filter(User.id == user_id).first()
        print(f"✓ 找到用户: {username} (ID: {user_id}, 角色: {user.role})")
        
        # 测试每日分析
        test_daily_analysis(db, user_id)
        
        # 测试 L7D 分析
        test_l7d_analysis(db, user_id)
        
        print("\n" + "="*60)
        print("测试完成！")
        print("="*60)
        
    except Exception as e:
        print(f"✗ 测试失败: {str(e)}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()

if __name__ == "__main__":
    main()

