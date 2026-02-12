"""
检查平台账号配置状态
"""

from sqlalchemy import create_engine, text

def main():
    engine = create_engine('sqlite:///google_analysis.db')
    
    print("=" * 60)
    print("平台账号配置检查")
    print("=" * 60)
    
    with engine.connect() as conn:
        # 1. 检查所有用户
        print("\n=== 所有用户 ===")
        result = conn.execute(text("""
            SELECT id, username, role, team_id 
            FROM users 
            WHERE username LIKE 'wj%' OR username = 'manager'
            ORDER BY username
        """))
        users = list(result)
        for u in users:
            print(f"  ID {u[0]}: {u[1]} (role: {u[2]}, team_id: {u[3]})")
        
        # 2. 检查 wj07 的账号
        print("\n=== wj07 的平台账号 ===")
        result = conn.execute(text("""
            SELECT aa.id, aa.account_name, ap.platform_code, aa.account_code, aa.email, aa.is_active, aa.notes
            FROM affiliate_accounts aa
            JOIN affiliate_platforms ap ON aa.platform_id = ap.id
            JOIN users u ON aa.user_id = u.id
            WHERE u.username = 'wj07'
        """))
        accounts = list(result)
        if accounts:
            for acc in accounts:
                print(f"  ID {acc[0]}: {acc[1]} ({acc[2]}) - 渠道:{acc[3]} - 邮箱:{acc[4]} - 状态:{'激活' if acc[5] else '停用'}")
                if acc[6]:
                    print(f"    备注: {acc[6][:100]}...")
        else:
            print("  没有找到账号")
        
        # 3. 检查 RW 平台的所有账号
        print("\n=== RW 平台所有账号 ===")
        result = conn.execute(text("""
            SELECT u.username, aa.id, aa.account_name, aa.account_code, aa.email, aa.is_active, aa.notes
            FROM affiliate_accounts aa
            JOIN affiliate_platforms ap ON aa.platform_id = ap.id
            JOIN users u ON aa.user_id = u.id
            WHERE ap.platform_code IN ('rw', 'RW', 'rewardoo')
            ORDER BY u.username, aa.account_name
        """))
        accounts = list(result)
        if accounts:
            for acc in accounts:
                print(f"  [{acc[0]}] ID {acc[1]}: {acc[2]} - 渠道:{acc[3]} - 邮箱:{acc[4]}")
        else:
            print("  没有找到 RW 平台账号")
        
        # 4. 检查 wj01-wj10 各自的账号数量
        print("\n=== wj01-wj10 账号统计 ===")
        for i in range(1, 11):
            username = f"wj{i:02d}"
            result = conn.execute(text(f"""
                SELECT ap.platform_code, COUNT(*) 
                FROM affiliate_accounts aa
                JOIN affiliate_platforms ap ON aa.platform_id = ap.id
                JOIN users u ON aa.user_id = u.id
                WHERE u.username = '{username}'
                GROUP BY ap.platform_code
            """))
            counts = list(result)
            if counts:
                platforms_str = ", ".join([f"{c[0]}:{c[1]}" for c in counts])
                print(f"  {username}: {platforms_str}")
            else:
                print(f"  {username}: 无账号")
        
        # 5. 检查是否有账号关联到旧的 wenjun123 用户
        print("\n=== 检查旧 wenjun123 账号的数据 ===")
        result = conn.execute(text("""
            SELECT aa.id, aa.account_name, ap.platform_code, aa.user_id
            FROM affiliate_accounts aa
            JOIN affiliate_platforms ap ON aa.platform_id = ap.id
            WHERE aa.user_id NOT IN (SELECT id FROM users)
        """))
        orphans = list(result)
        if orphans:
            print(f"  发现 {len(orphans)} 个孤立账号（用户已删除）:")
            for o in orphans:
                print(f"    ID {o[0]}: {o[1]} ({o[2]}) - user_id: {o[3]}")
        else:
            print("  没有孤立账号")
        
        # 6. 检查 manager 账号的平台账号
        print("\n=== manager 的平台账号 ===")
        result = conn.execute(text("""
            SELECT aa.id, aa.account_name, ap.platform_code, aa.account_code, aa.email
            FROM affiliate_accounts aa
            JOIN affiliate_platforms ap ON aa.platform_id = ap.id
            JOIN users u ON aa.user_id = u.id
            WHERE u.username = 'manager'
        """))
        accounts = list(result)
        if accounts:
            for acc in accounts:
                print(f"  ID {acc[0]}: {acc[1]} ({acc[2]}) - 渠道:{acc[3]} - 邮箱:{acc[4]}")
        else:
            print("  没有找到账号")

if __name__ == "__main__":
    main()

