#!/usr/bin/env python3
"""
检查各平台的 API 配置状态
诊断为什么平台同步失败
"""
import sys
import os
import json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal
from app.models.affiliate_account import AffiliateAccount
from app.models.affiliate_platform import AffiliatePlatform
from app.models.user import User

db = SessionLocal()

print("=" * 80)
print("平台 API 配置检查")
print("=" * 80)

# 获取所有平台
platforms = db.query(AffiliatePlatform).all()
print(f"\n已配置平台 ({len(platforms)} 个):")
print("-" * 80)
for p in platforms:
    print(f"  ID={p.id}, name={p.name}, code={p.code}")
    if hasattr(p, 'api_url') and p.api_url:
        print(f"    API URL: {p.api_url}")
    if hasattr(p, 'api_config') and p.api_config:
        print(f"    API Config: {p.api_config}")

# 检查各用户的账号配置
print("\n" + "=" * 80)
print("用户账号 API 配置检查")
print("=" * 80)

users = db.query(User).filter(User.role == 'employee').all()

for user in users:
    accounts = db.query(AffiliateAccount).filter(
        AffiliateAccount.user_id == user.id,
        AffiliateAccount.is_active == True
    ).all()
    
    if not accounts:
        continue
    
    print(f"\n【{user.username}】({len(accounts)} 个账号)")
    
    for acc in accounts:
        platform = db.query(AffiliatePlatform).filter(AffiliatePlatform.id == acc.platform_id).first()
        platform_name = platform.name if platform else "未知"
        
        # 检查 API Token
        token = None
        api_url = None
        
        # 尝试从 notes 中提取配置
        if acc.notes:
            try:
                notes = json.loads(acc.notes) if isinstance(acc.notes, str) else acc.notes
                token = notes.get('api_token') or notes.get('rw_token') or notes.get('cg_token')
                api_url = notes.get('api_url') or notes.get(f'{platform_name.lower()}_api_url')
            except:
                pass
        
        # 状态判断
        token_status = "✓ 已配置" if token else "✗ 未配置"
        url_status = "✓ 已配置" if api_url else "使用默认"
        
        has_issue = not token
        issue_marker = " ⚠️" if has_issue else ""
        
        print(f"  {platform_name}: {acc.account_name}{issue_marker}")
        print(f"    Token: {token_status}")
        if api_url:
            print(f"    API URL: {api_url}")

# 特别检查 BSH 和有问题的账号
print("\n" + "=" * 80)
print("特别检查：BSH 平台配置")
print("=" * 80)

bsh_platform = db.query(AffiliatePlatform).filter(
    AffiliatePlatform.name.ilike('%bsh%') | 
    AffiliatePlatform.name.ilike('%brandspark%') |
    AffiliatePlatform.code.ilike('%brandspark%')
).first()

if bsh_platform:
    print(f"BSH 平台: ID={bsh_platform.id}, name={bsh_platform.name}")
    print(f"  code: {bsh_platform.code}")
    if hasattr(bsh_platform, 'api_url'):
        print(f"  api_url: {bsh_platform.api_url}")
    if hasattr(bsh_platform, 'api_config'):
        print(f"  api_config: {bsh_platform.api_config}")
    
    # 检查 BSH 账号
    bsh_accounts = db.query(AffiliateAccount).filter(
        AffiliateAccount.platform_id == bsh_platform.id
    ).all()
    print(f"\n  BSH 账号 ({len(bsh_accounts)} 个):")
    for acc in bsh_accounts:
        user = db.query(User).filter(User.id == acc.user_id).first()
        print(f"    - {acc.account_name} (用户: {user.username if user else 'N/A'})")
        if acc.notes:
            try:
                notes = json.loads(acc.notes) if isinstance(acc.notes, str) else acc.notes
                print(f"      notes: {json.dumps(notes, indent=8)}")
            except:
                print(f"      notes: {acc.notes}")
else:
    print("未找到 BSH 平台配置")

# 检查 wj02 的 CG 账号
print("\n" + "=" * 80)
print("特别检查：wj02 的 CG 账号 (wenjun3)")
print("=" * 80)

wj02 = db.query(User).filter(User.username == 'wj02').first()
if wj02:
    cg_platform = db.query(AffiliatePlatform).filter(
        AffiliatePlatform.name.ilike('%cg%') | 
        AffiliatePlatform.code.ilike('%collabglow%')
    ).first()
    
    if cg_platform:
        wj02_cg = db.query(AffiliateAccount).filter(
            AffiliateAccount.user_id == wj02.id,
            AffiliateAccount.platform_id == cg_platform.id
        ).first()
        
        if wj02_cg:
            print(f"账号: {wj02_cg.account_name}")
            print(f"  email: {wj02_cg.email}")
            print(f"  is_active: {wj02_cg.is_active}")
            if wj02_cg.notes:
                try:
                    notes = json.loads(wj02_cg.notes) if isinstance(wj02_cg.notes, str) else wj02_cg.notes
                    # 隐藏部分 token
                    for key in notes:
                        if 'token' in key.lower() and notes[key]:
                            notes[key] = notes[key][:8] + '...' + notes[key][-4:] if len(notes[key]) > 12 else '***'
                    print(f"  notes: {json.dumps(notes, indent=4)}")
                except:
                    print(f"  notes: {wj02_cg.notes}")
        else:
            print("未找到 wj02 的 CG 账号")
    else:
        print("未找到 CG 平台")
else:
    print("未找到 wj02 用户")

db.close()
print("\n" + "=" * 80)

