"""
修复平台代码：将 URL 格式的 platform_code 标准化为小写缩写
"""

import argparse
from sqlalchemy import create_engine, text

# URL 到标准代码的映射
URL_TO_CODE_MAP = {
    'https://www.rewardoo.com/': 'rw',
    'https://app.collabglow.com/': 'cg',
    'https://www.linkhaitao.com/': 'lh',
    'https://app.partnermatic.com': 'pm',
    'https://app.partnermatic.com/': 'pm',
    'https://www.brandsparkhub.com/': 'bsh',
    'https://www.linkbux.com/': 'lb',
    'https://www.creatorflare.com/': 'cf',
    'https://www.partnerboost.com/': 'pb',
}

# 标准代码到显示名称的映射
CODE_TO_NAME_MAP = {
    'rw': 'Rewardoo',
    'cg': 'CollabGlow', 
    'lh': 'LinkHaiTao',
    'pm': 'PartnerMatic',
    'bsh': 'BrandSparkHub',
    'lb': 'LinkBux',
    'cf': 'CreatorFlare',
    'pb': 'PartnerBoost',
}

def main():
    parser = argparse.ArgumentParser(description='修复平台代码')
    parser.add_argument('--dry-run', action='store_true', help='预览模式，不实际修改')
    args = parser.parse_args()
    
    engine = create_engine('sqlite:///google_analysis.db')
    
    print("=" * 60)
    print("修复平台代码（URL → 标准缩写）")
    print("=" * 60)
    print(f"模式: {'预览 (不修改)' if args.dry_run else '正式执行'}")
    print()
    
    print("映射规则:")
    for url, code in URL_TO_CODE_MAP.items():
        print(f"  {url} → {code}")
    print()
    
    with engine.connect() as conn:
        # 1. 检查当前 affiliate_platforms 表
        print("=== 当前 affiliate_platforms 表 ===")
        result = conn.execute(text("SELECT id, platform_code, platform_name FROM affiliate_platforms ORDER BY id"))
        platforms = list(result)
        
        updates_needed = []
        for p in platforms:
            platform_id, platform_code, platform_name = p
            print(f"  ID {platform_id}: code='{platform_code}', name='{platform_name}'")
            
            # 检查是否需要修复
            if platform_code in URL_TO_CODE_MAP:
                new_code = URL_TO_CODE_MAP[platform_code]
                new_name = CODE_TO_NAME_MAP.get(new_code, platform_name)
                updates_needed.append({
                    'id': platform_id,
                    'old_code': platform_code,
                    'new_code': new_code,
                    'old_name': platform_name,
                    'new_name': new_name
                })
        
        print()
        
        if not updates_needed:
            print("没有需要修复的平台代码")
            return
        
        print(f"=== 需要修复 {len(updates_needed)} 条记录 ===")
        for u in updates_needed:
            print(f"  ID {u['id']}: '{u['old_code']}' → '{u['new_code']}' (name: '{u['old_name']}' → '{u['new_name']}')")
        print()
        
        if args.dry_run:
            print("预览模式，未修改数据库。")
            print("使用不带 --dry-run 参数执行来实际修改数据。")
            return
        
        # 执行更新
        print("正在更新数据...")
        for u in updates_needed:
            conn.execute(text("""
                UPDATE affiliate_platforms 
                SET platform_code = :new_code, platform_name = :new_name
                WHERE id = :id
            """), {
                'id': u['id'],
                'new_code': u['new_code'],
                'new_name': u['new_name']
            })
            print(f"  ✓ ID {u['id']}: {u['old_code']} → {u['new_code']}")
        
        conn.commit()
        
        print()
        print("✓ 平台代码修复完成!")
        print()
        
        # 验证结果
        print("=== 修复后的 affiliate_platforms 表 ===")
        result = conn.execute(text("SELECT id, platform_code, platform_name FROM affiliate_platforms ORDER BY id"))
        for p in result:
            print(f"  ID {p[0]}: code='{p[1]}', name='{p[2]}'")

if __name__ == "__main__":
    main()

