#!/usr/bin/env python3
"""
设置MCC同步所需配置
1. 检查并配置Developer Token
2. 检查并修复MCC账号状态
3. 验证MCC ID格式
"""
import sys
import os
from pathlib import Path

# 添加项目根目录到路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.models.google_ads_api_data import GoogleMccAccount
from app.config import settings

# 创建数据库会话
engine = create_engine(settings.DATABASE_URL, echo=False)
Session = sessionmaker(bind=engine)
db = Session()

def setup_developer_token():
    """设置Developer Token"""
    print("=" * 80)
    print("配置Developer Token")
    print("=" * 80)
    
    env_file = Path(__file__).parent.parent / ".env"
    
    # 检查当前配置
    current_token = settings.google_ads_shared_developer_token
    has_token = bool(current_token and current_token.strip())
    
    if has_token:
        print(f"\n[成功] Developer Token已配置")
        print(f"  Token长度: {len(current_token)} 字符")
        return True
    
    print(f"\n[警告] Developer Token未配置")
    print(f"\n.env文件路径: {env_file}")
    
    if env_file.exists():
        print(f"[信息] .env文件已存在")
        # 读取现有内容
        with open(env_file, 'r', encoding='utf-8') as f:
            content = f.read()
        
        if 'GOOGLE_ADS_SHARED_DEVELOPER_TOKEN' in content:
            print("[信息] .env文件中已有GOOGLE_ADS_SHARED_DEVELOPER_TOKEN配置，但值为空")
            print("   请手动编辑.env文件，设置正确的Developer Token值")
        else:
            print("[信息] .env文件中没有GOOGLE_ADS_SHARED_DEVELOPER_TOKEN配置")
            # 添加配置
            with open(env_file, 'a', encoding='utf-8') as f:
                f.write("\n# Google Ads API配置\n")
                f.write("GOOGLE_ADS_SHARED_DEVELOPER_TOKEN=\n")
            print("[完成] 已在.env文件中添加GOOGLE_ADS_SHARED_DEVELOPER_TOKEN配置")
            print("   请手动编辑.env文件，设置正确的Developer Token值")
    else:
        print(f"[信息] .env文件不存在，正在创建...")
        # 创建.env文件
        with open(env_file, 'w', encoding='utf-8') as f:
            f.write("# Google Ads API配置\n")
            f.write("GOOGLE_ADS_SHARED_DEVELOPER_TOKEN=\n")
        print("[完成] 已创建.env文件")
        print("   请手动编辑.env文件，设置正确的Developer Token值")
    
    print("\n配置步骤:")
    print("1. 打开文件: " + str(env_file))
    print("2. 找到 GOOGLE_ADS_SHARED_DEVELOPER_TOKEN= 这一行")
    print("3. 在等号后面填入你的Google Ads Developer Token")
    print("4. 保存文件")
    print("5. 重启后端服务")
    
    return False

def check_and_fix_mcc_accounts():
    """检查并修复MCC账号"""
    print("\n" + "=" * 80)
    print("检查MCC账号配置")
    print("=" * 80)
    
    mcc_accounts = db.query(GoogleMccAccount).all()
    
    if not mcc_accounts:
        print("\n[警告] 数据库中没有MCC账号")
        print("   请在系统中添加MCC账号")
        return []
    
    print(f"\n找到 {len(mcc_accounts)} 个MCC账号")
    
    fixed_count = 0
    issues = []
    
    for mcc in mcc_accounts:
        print(f"\n检查MCC账号: {mcc.mcc_name} (ID: {mcc.id})")
        print(f"  MCC ID: {mcc.mcc_id}")
        
        # 检查状态
        if not mcc.is_active:
            print(f"  [问题] 账号状态: 停用")
            print(f"  [修复] 正在激活账号...")
            mcc.is_active = True
            db.commit()
            fixed_count += 1
            print(f"  [成功] 账号已激活")
        else:
            print(f"  [正常] 账号状态: 激活")
        
        # 检查MCC ID格式
        mcc_id_clean = mcc.mcc_id.replace("-", "").strip()
        is_valid_format = mcc_id_clean.isdigit() and len(mcc_id_clean) == 10
        
        if not is_valid_format:
            print(f"  [问题] MCC ID格式错误")
            print(f"    原始: {mcc.mcc_id}")
            print(f"    清理后: {mcc_id_clean} ({len(mcc_id_clean)} 位)")
            print(f"    要求: 10位数字（去掉横线后）")
            issues.append({
                'mcc_id': mcc.id,
                'mcc_name': mcc.mcc_name,
                'current_id': mcc.mcc_id,
                'cleaned_id': mcc_id_clean,
                'issue': 'MCC ID格式错误'
            })
        else:
            print(f"  [正常] MCC ID格式正确: {mcc_id_clean} (10位数字)")
        
        # 检查API配置
        has_client_id = bool(mcc.client_id)
        has_client_secret = bool(mcc.client_secret)
        has_refresh_token = bool(mcc.refresh_token)
        
        print(f"  API配置:")
        print(f"    Client ID: {'[已配置]' if has_client_id else '[未配置]'}")
        print(f"    Client Secret: {'[已配置]' if has_client_secret else '[未配置]'}")
        print(f"    Refresh Token: {'[已配置]' if has_refresh_token else '[未配置]'}")
        
        if not (has_client_id and has_client_secret and has_refresh_token):
            issues.append({
                'mcc_id': mcc.id,
                'mcc_name': mcc.mcc_name,
                'issue': 'API配置不完整'
            })
    
    if fixed_count > 0:
        print(f"\n[成功] 已自动修复 {fixed_count} 个MCC账号的状态")
    
    if issues:
        print(f"\n[警告] 发现 {len(issues)} 个需要手动修复的问题:")
        for i, issue in enumerate(issues, 1):
            print(f"\n{i}. {issue['mcc_name']} (ID: {issue['mcc_id']})")
            print(f"   问题: {issue['issue']}")
            if 'current_id' in issue:
                print(f"   当前MCC ID: {issue['current_id']}")
                print(f"   清理后: {issue['cleaned_id']} ({len(issue['cleaned_id'])} 位)")
                print(f"   解决方法: 请编辑MCC账号，将MCC ID修改为10位数字格式")
            else:
                print(f"   解决方法: 请编辑MCC账号，填写完整的API配置（Client ID、Client Secret、Refresh Token）")
    
    return issues

def main():
    print("\n" + "=" * 80)
    print("MCC同步配置检查和修复工具")
    print("=" * 80)
    
    # 1. 检查Developer Token
    has_token = setup_developer_token()
    
    # 2. 检查并修复MCC账号
    issues = check_and_fix_mcc_accounts()
    
    # 总结
    print("\n" + "=" * 80)
    print("配置总结")
    print("=" * 80)
    
    if has_token:
        print("\n[成功] Developer Token已配置")
    else:
        print("\n[待处理] Developer Token需要手动配置")
    
    if not issues:
        print("\n[成功] 所有MCC账号配置正常！")
    else:
        print(f"\n[待处理] 有 {len(issues)} 个问题需要手动修复")
        print("   请按照上面的说明进行修复")
    
    print("\n" + "=" * 80)
    print("下一步操作")
    print("=" * 80)
    print("\n1. 如果Developer Token未配置，请编辑 .env 文件并设置GOOGLE_ADS_SHARED_DEVELOPER_TOKEN")
    print("2. 如果MCC账号有问题，请在系统中编辑相应的MCC账号")
    print("3. 配置完成后，重启后端服务")
    print("4. 再次运行此脚本验证配置是否正确")
    
    db.close()

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\n[错误] {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

















