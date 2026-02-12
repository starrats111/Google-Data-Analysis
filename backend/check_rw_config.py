"""
检查 RW 账号的 API 配置
"""
import json
from sqlalchemy import create_engine, text

def main():
    engine = create_engine('sqlite:///google_analysis.db')
    
    print("=" * 60)
    print("RW 平台账号 API 配置检查")
    print("=" * 60)
    
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
        
        for acc in accounts:
            username, acc_id, acc_name, notes = acc
            print(f"[{username}] {acc_name} (ID: {acc_id})")
            
            if notes:
                try:
                    config = json.loads(notes)
                    token = config.get('rewardoo_token') or config.get('api_token')
                    api_url = config.get('rewardoo_api_url')
                    
                    print(f"  Token: {'已配置' if token else '未配置'} ({token[:20]}...)" if token else "  Token: 未配置")
                    print(f"  API URL: {api_url if api_url else '未配置（将使用默认值）'}")
                    
                    # 检查 API URL 是否正确
                    if api_url:
                        if 'admin.rewardoo.com' in api_url and 'api.php' in api_url:
                            print(f"  状态: ✓ API URL 格式正确")
                        else:
                            print(f"  状态: ✗ API URL 格式可能有误！")
                            print(f"         正确格式应为: https://admin.rewardoo.com/api.php?mod=medium&op=transaction_details")
                    else:
                        print(f"  状态: 将使用默认 API URL")
                except json.JSONDecodeError:
                    print(f"  备注: {notes[:100]}...")
                    print(f"  状态: 备注不是有效的JSON格式")
            else:
                print(f"  备注: 无")
                print(f"  状态: 未配置API信息")
            
            print()

if __name__ == "__main__":
    main()

