"""
诊断脚本：检查MCC账号的API配置是否已保存
"""
import sys
import os

# 添加项目根目录到路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal
from app.models.google_ads_api_data import GoogleMccAccount

def check_mcc_accounts():
    """检查所有MCC账号的API配置"""
    db = SessionLocal()
    try:
        mcc_accounts = db.query(GoogleMccAccount).all()
        
        print(f"找到 {len(mcc_accounts)} 个MCC账号：\n")
        
        for mcc in mcc_accounts:
            print(f"MCC ID: {mcc.mcc_id}")
            print(f"  名称: {mcc.mcc_name}")
            print(f"  邮箱: {mcc.email}")
            print(f"  Client ID: {'已配置' if mcc.client_id else '未配置'} ({mcc.client_id[:20] + '...' if mcc.client_id and len(mcc.client_id) > 20 else mcc.client_id or 'None'})")
            print(f"  Client Secret: {'已配置' if mcc.client_secret else '未配置'} ({'***' if mcc.client_secret else 'None'})")
            print(f"  Refresh Token: {'已配置' if mcc.refresh_token else '未配置'} ({'***' if mcc.refresh_token else 'None'})")
            print(f"  状态: {'激活' if mcc.is_active else '停用'}")
            print()
        
    except Exception as e:
        print(f"错误: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()

if __name__ == "__main__":
    check_mcc_accounts()

