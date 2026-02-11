"""
根据Excel记录清理数据库中的平台账号
- 删除Excel中没有的账号
- 保留Excel中存在的账号
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform

# Excel中正确的账号配置 (用户名 -> {平台: [账号名列表]})
CORRECT_ACCOUNTS = {
    'wj01': {
        'LB': ['tuancha'],
        'CG': ['weili'],
        'BSH': ['bloomroots'],
        'PM': ['kivanta'],
    },
    'wj02': {
        'PM': ['novanest'],
        'CG': ['wenjun3'],
        'LH': ['wenjun1'],
        # BSH-allurahub 无法使用，不添加
    },
    'wj03': {
        'CG': ['novanest'],
        'LH': ['tuancha'],
        'RW': ['wenjun03'],
        'PM': ['keymint'],
        # CF-allurahub 无法使用，不添加
    },
    'wj04': {
        'PM': ['weilixia'],
        'LH': ['bloomroots'],
        'BSH': ['everydayhaven'],
        'CG': ['keymint'],
        # RW-wenjun 账号无法登录，不添加
    },
    'wj05': {
        'LH': ['kagetsu'],
        'PM': ['vitahaven'],
        'RW': ['everydayhaven'],  # RW-allurahub无法使用，只保留everydayhaven
        'CG': ['vitasphere'],
    },
    'wj06': {
        'RW': ['kaizenflowshop'],
        'CG': ['wenjun2'],
        'PM': ['everydayhaven'],
        'CF': ['everydayhaven'],
    },
    'wj07': {
        'LH': ['wenjun3'],
        'RW': ['wenjun'],
        # CG-allurahub1 无法使用，不添加
    },
    'wj08': {
        'PM': ['tuancha'],
        'LH': ['wenjun2'],
        'CF': ['bloomroots'],
    },
    'wj09': {
        'PM': ['vitasphere'],
        'RW': ['bloomroots'],
        # LB-weilixia, CG-everydayhaven 都无法使用，不添加
    },
    'wj10': {
        'PM': ['bloomroots'],
        'CG': ['bloomroots'],
        'RW': ['thgoodsandguard'],
        # LH-allurahub 无法使用，不添加
    },
}

def main():
    db = SessionLocal()
    
    try:
        # 获取所有平台
        platforms = {p.platform_name.upper(): p.id for p in db.query(AffiliatePlatform).all()}
        platforms_by_id = {p.id: p.platform_name.upper() for p in db.query(AffiliatePlatform).all()}
        print("平台映射:", platforms)
        print()
        
        # 获取所有员工用户
        users = db.query(User).filter(User.role == 'employee').order_by(User.username).all()
        user_map = {u.username: u.id for u in users}
        
        to_delete = []
        to_keep = []
        
        for user in users:
            username = user.username
            if username not in CORRECT_ACCOUNTS:
                print(f"【{username}】不在配置中，跳过")
                continue
            
            correct_config = CORRECT_ACCOUNTS[username]
            
            # 获取该用户的所有账号
            accounts = db.query(AffiliateAccount).filter(
                AffiliateAccount.user_id == user.id
            ).all()
            
            print(f"\n【{username}】")
            print(f"  Excel配置: {correct_config}")
            
            for acc in accounts:
                platform_name = platforms_by_id.get(acc.platform_id, '?')
                account_name = acc.account_name.strip() if acc.account_name else ''
                
                # 检查是否在正确配置中
                is_correct = False
                if platform_name in correct_config:
                    correct_names = [n.lower().strip() for n in correct_config[platform_name]]
                    if account_name.lower() in correct_names:
                        is_correct = True
                
                if is_correct:
                    to_keep.append((acc.id, username, platform_name, account_name))
                    print(f"  ✓ 保留: ID={acc.id} {platform_name}-{account_name}")
                else:
                    to_delete.append((acc.id, username, platform_name, account_name))
                    print(f"  ✗ 删除: ID={acc.id} {platform_name}-{account_name}")
        
        print("\n" + "=" * 80)
        print(f"总计: 保留 {len(to_keep)} 个，删除 {len(to_delete)} 个")
        print("=" * 80)
        
        if to_delete:
            print("\n将要删除的账号:")
            for acc_id, username, platform, name in to_delete:
                print(f"  ID={acc_id}: {username} - {platform} - {name}")
            
            confirm = input("\n确认删除这些账号? (输入 'yes' 确认): ")
            if confirm.lower() == 'yes':
                for acc_id, _, _, _ in to_delete:
                    acc = db.query(AffiliateAccount).filter(AffiliateAccount.id == acc_id).first()
                    if acc:
                        db.delete(acc)
                db.commit()
                print(f"\n✓ 已删除 {len(to_delete)} 个账号")
            else:
                print("\n取消删除操作")
        else:
            print("\n没有需要删除的账号")
        
    finally:
        db.close()

if __name__ == "__main__":
    main()

