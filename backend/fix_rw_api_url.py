"""
修复 RW 账号的错误 API URL 配置
"""
import json
import argparse
from sqlalchemy import create_engine, text

# 错误的 URL 模式
WRONG_URL_PATTERNS = [
    'parcelandplate',
    'apidoc',
    'www.rewardoo.com',  # 应该是 admin.rewardoo.com
]

def main():
    parser = argparse.ArgumentParser(description='修复RW API URL配置')
    parser.add_argument('--dry-run', action='store_true', help='预览模式，不实际修改')
    args = parser.parse_args()
    
    engine = create_engine('sqlite:///google_analysis.db')
    
    print("=" * 60)
    print("修复 RW 平台账号 API URL 配置")
    print("=" * 60)
    print(f"模式: {'预览 (不修改)' if args.dry_run else '正式执行'}")
    print()
    
    with engine.connect() as conn:
        # 查找所有 RW 平台账号
        result = conn.execute(text("""
            SELECT u.username, aa.id, aa.account_name, aa.notes
            FROM affiliate_accounts aa
            JOIN affiliate_platforms ap ON aa.platform_id = ap.id
            JOIN users u ON aa.user_id = u.id
            WHERE ap.platform_code = 'rw'
            ORDER BY u.username, aa.account_name
        """))
        
        accounts = list(result)
        print(f"找到 {len(accounts)} 个 RW 账号")
        print()
        
        fixes_needed = []
        
        for acc in accounts:
            username, acc_id, acc_name, notes = acc
            
            if not notes:
                continue
            
            try:
                config = json.loads(notes)
                api_url = config.get('rewardoo_api_url')
                
                if api_url:
                    # 检查是否是错误的 URL
                    is_wrong = any(pattern in api_url for pattern in WRONG_URL_PATTERNS)
                    
                    if is_wrong:
                        fixes_needed.append({
                            'id': acc_id,
                            'username': username,
                            'account_name': acc_name,
                            'old_url': api_url,
                            'config': config
                        })
                        print(f"需要修复: [{username}] {acc_name} (ID: {acc_id})")
                        print(f"  错误URL: {api_url}")
                        print()
            except json.JSONDecodeError:
                continue
        
        if not fixes_needed:
            print("没有需要修复的账号")
            return
        
        print(f"共 {len(fixes_needed)} 个账号需要修复")
        print()
        
        if args.dry_run:
            print("预览模式，未修改数据库。")
            print("使用不带 --dry-run 参数执行来实际修改数据。")
            return
        
        # 执行修复：删除错误的 rewardoo_api_url，让系统使用默认值
        print("正在修复...")
        for fix in fixes_needed:
            config = fix['config']
            # 删除错误的 API URL 配置
            if 'rewardoo_api_url' in config:
                del config['rewardoo_api_url']
            
            new_notes = json.dumps(config, ensure_ascii=False)
            
            conn.execute(text("""
                UPDATE affiliate_accounts 
                SET notes = :notes
                WHERE id = :id
            """), {'id': fix['id'], 'notes': new_notes})
            
            print(f"  ✓ [{fix['username']}] {fix['account_name']}: 已删除错误的API URL配置")
        
        conn.commit()
        
        print()
        print("✓ 修复完成！")
        print("这些账号现在将使用默认的 API URL:")
        print("  https://admin.rewardoo.com/api.php?mod=medium&op=transaction_details")

if __name__ == "__main__":
    main()

