"""
更新所有MCC的服务账号JSON
用法: python -m scripts.update_all_service_accounts <json文件路径>
例如: python -m scripts.update_all_service_accounts /home/admin/service_account.json
"""
import sys
import json
import os

# 添加项目路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.models.google_ads_api_data import GoogleMccAccount
from app.database import SessionLocal


def main():
    if len(sys.argv) < 2:
        print("❌ 请提供JSON文件路径")
        print("用法: python -m scripts.update_all_service_accounts <json文件路径>")
        sys.exit(1)
    
    json_file = sys.argv[1]
    
    if not os.path.exists(json_file):
        print(f"❌ 文件不存在: {json_file}")
        sys.exit(1)
    
    # 读取JSON文件
    try:
        with open(json_file, 'r', encoding='utf-8') as f:
            sa_data = json.load(f)
        
        # 验证JSON格式
        required_fields = ['type', 'project_id', 'private_key', 'client_email']
        for field in required_fields:
            if field not in sa_data:
                print(f"❌ JSON缺少必要字段: {field}")
                sys.exit(1)
        
        sa_json_str = json.dumps(sa_data)
        print(f"✅ 已读取服务账号JSON")
        print(f"   项目: {sa_data['project_id']}")
        print(f"   邮箱: {sa_data['client_email']}")
    except Exception as e:
        print(f"❌ 读取JSON失败: {e}")
        sys.exit(1)
    
    # 更新数据库
    db = SessionLocal()
    try:
        mccs = db.query(GoogleMccAccount).all()
        print(f"\n📋 数据库中共有 {len(mccs)} 个MCC账号")
        
        if not mccs:
            print("⚠️ 没有MCC账号需要更新")
            return
        
        updated = 0
        for mcc in mccs:
            mcc.service_account_json = sa_json_str
            mcc.use_service_account = True
            updated += 1
            print(f"   ✅ 已更新 MCC: {mcc.mcc_id} ({mcc.mcc_name})")
        
        db.commit()
        print(f"\n🎉 成功更新 {updated} 个MCC账号的服务账号配置！")
        print(f"   新服务邮箱: {sa_data['client_email']}")
        
    except Exception as e:
        db.rollback()
        print(f"❌ 更新失败: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()


if __name__ == "__main__":
    main()

