#!/usr/bin/env python3
"""
检查MCC配置
确保MCC账号状态、Developer Token和MCC ID格式正确
"""
import sys
import os
from pathlib import Path

# 添加项目根目录到路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.models.google_ads_api_data import GoogleMccAccount
from app.models.user import User
from app.config import settings

# 创建数据库会话
engine = create_engine(settings.DATABASE_URL, echo=False)
Session = sessionmaker(bind=engine)
db = Session()

def check_developer_token():
    """检查Developer Token配置"""
    print("=" * 80)
    print("检查Developer Token配置")
    print("=" * 80)
    
    dev_token = settings.google_ads_shared_developer_token
    has_token = bool(dev_token and dev_token.strip())
    
    print(f"\nDeveloper Token状态: {'[已配置]' if has_token else '[未配置]'}")
    
    if has_token:
        print(f"  Token长度: {len(dev_token)} 字符")
        print(f"  Token预览: {dev_token[:10]}...")
        print("\n[成功] Developer Token已配置")
    else:
        print("\n[错误] Developer Token未配置")
        print("\n解决方法:")
        print("1. 打开 backend/.env 文件")
        print("2. 添加或修改以下配置:")
        print("   GOOGLE_ADS_SHARED_DEVELOPER_TOKEN=你的开发者令牌")
        print("3. 如果没有 .env 文件，请创建它")
        print("4. 重启后端服务")
        
        # 检查.env文件是否存在
        env_file = Path(__file__).parent.parent / ".env"
        if env_file.exists():
            print(f"\n[信息] .env 文件存在: {env_file}")
            print("   请检查文件中是否有 GOOGLE_ADS_SHARED_DEVELOPER_TOKEN 配置")
        else:
            print(f"\n[警告] .env 文件不存在: {env_file}")
            print("   需要创建 .env 文件并添加配置")
    
    return has_token

def check_mcc_accounts():
    """检查所有MCC账号的配置"""
    print("\n" + "=" * 80)
    print("检查MCC账号配置")
    print("=" * 80)
    
    mcc_accounts = db.query(GoogleMccAccount).all()
    
    if not mcc_accounts:
        print("\n[警告] 数据库中没有MCC账号")
        return []
    
    print(f"\n找到 {len(mcc_accounts)} 个MCC账号:")
    
    issues = []
    for i, mcc in enumerate(mcc_accounts, 1):
        print(f"\n{i}. MCC账号: {mcc.mcc_name} (ID: {mcc.id})")
        print(f"   MCC ID: {mcc.mcc_id}")
        print(f"   用户ID: {mcc.user_id}")
        
        # 检查用户信息
        user = db.query(User).filter(User.id == mcc.user_id).first()
        if user:
            print(f"   用户名: {user.username}")
        
        # 检查状态
        is_active = mcc.is_active
        print(f"   状态: {'[激活]' if is_active else '[停用]'}")
        
        if not is_active:
            issues.append({
                'mcc_id': mcc.id,
                'mcc_name': mcc.mcc_name,
                'issue': '账号已停用',
                'fix': f"需要将MCC账号 {mcc.id} ({mcc.mcc_name}) 的状态设置为激活"
            })
            print(f"   [问题] 账号已停用，无法同步")
        
        # 检查MCC ID格式
        mcc_id_clean = mcc.mcc_id.replace("-", "").strip()
        is_valid_format = mcc_id_clean.isdigit() and len(mcc_id_clean) == 10
        
        print(f"   MCC ID格式: {'[有效]' if is_valid_format else '[无效]'}")
        print(f"     原始: {mcc.mcc_id}")
        print(f"     清理后: {mcc_id_clean} ({len(mcc_id_clean)} 位)")
        
        if not is_valid_format:
            issues.append({
                'mcc_id': mcc.id,
                'mcc_name': mcc.mcc_name,
                'issue': 'MCC ID格式错误',
                'fix': f"MCC账号 {mcc.id} ({mcc.mcc_name}) 的MCC ID格式不正确，必须是10位数字"
            })
            print(f"   [问题] MCC ID格式不正确，必须是10位数字")
        
        # 检查API配置
        has_client_id = bool(mcc.client_id)
        has_client_secret = bool(mcc.client_secret)
        has_refresh_token = bool(mcc.refresh_token)
        
        print(f"   API配置:")
        print(f"     Client ID: {'[已配置]' if has_client_id else '[未配置]'}")
        print(f"     Client Secret: {'[已配置]' if has_client_secret else '[未配置]'}")
        print(f"     Refresh Token: {'[已配置]' if has_refresh_token else '[未配置]'}")
        
        if not (has_client_id and has_client_secret and has_refresh_token):
            issues.append({
                'mcc_id': mcc.id,
                'mcc_name': mcc.mcc_name,
                'issue': 'API配置不完整',
                'fix': f"MCC账号 {mcc.id} ({mcc.mcc_name}) 缺少API配置，需要填写Client ID、Client Secret和Refresh Token"
            })
            print(f"   [问题] API配置不完整")
    
    return issues

def fix_mcc_status(mcc_id, activate=True):
    """修复MCC账号状态"""
    mcc = db.query(GoogleMccAccount).filter(GoogleMccAccount.id == mcc_id).first()
    if not mcc:
        print(f"[错误] 找不到ID为 {mcc_id} 的MCC账号")
        return False
    
    old_status = mcc.is_active
    mcc.is_active = activate
    db.commit()
    
    print(f"[成功] MCC账号 {mcc.mcc_name} (ID: {mcc_id}) 状态已从 {'激活' if old_status else '停用'} 改为 {'激活' if activate else '停用'}")
    return True

def main():
    print("\n" + "=" * 80)
    print("MCC配置检查工具")
    print("=" * 80)
    
    # 检查Developer Token
    has_dev_token = check_developer_token()
    
    # 检查MCC账号
    issues = check_mcc_accounts()
    
    # 总结
    print("\n" + "=" * 80)
    print("检查总结")
    print("=" * 80)
    
    if not has_dev_token:
        print("\n[错误] Developer Token未配置")
    
    if not issues:
        print("\n[成功] 所有MCC账号配置正常！")
    else:
        print(f"\n[警告] 发现 {len(issues)} 个问题:")
        for i, issue in enumerate(issues, 1):
            print(f"\n{i}. {issue['mcc_name']} (ID: {issue['mcc_id']})")
            print(f"   问题: {issue['issue']}")
            print(f"   解决方法: {issue['fix']}")
        
        # 询问是否自动修复停用的账号
        print("\n" + "=" * 80)
        print("自动修复选项")
        print("=" * 80)
        print("\n可以自动修复以下问题:")
        print("1. 激活已停用的MCC账号")
        print("\n注意: MCC ID格式错误和API配置不完整需要手动修复")
        
        # 检查是否有停用的账号
        inactive_mccs = [issue for issue in issues if issue['issue'] == '账号已停用']
        if inactive_mccs:
            print(f"\n发现 {len(inactive_mccs)} 个停用的MCC账号:")
            for issue in inactive_mccs:
                print(f"  - {issue['mcc_name']} (ID: {issue['mcc_id']})")
            
            # 自动激活所有停用的账号
            print("\n正在自动激活所有停用的MCC账号...")
            for issue in inactive_mccs:
                fix_mcc_status(issue['mcc_id'], activate=True)
            print("\n[完成] 所有停用的MCC账号已激活")
    
    db.close()

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\n[错误] {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
















