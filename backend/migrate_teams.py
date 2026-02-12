#!/usr/bin/env python3
"""
团队架构迁移脚本
1. 创建 teams 表
2. users 表添加 team_id 字段
3. 创建小组和账号
4. 迁移现有账号数据

运行方式：
    cd backend
    python migrate_teams.py --dry-run  # 预览
    python migrate_teams.py            # 执行
"""

import argparse
import sys
import os
from datetime import datetime
from passlib.context import CryptContext

# 添加项目路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sqlalchemy import create_engine, text, inspect
from sqlalchemy.orm import sessionmaker

# 数据库路径
DB_PATH = os.path.join(os.path.dirname(__file__), "google_analysis.db")
DATABASE_URL = f"sqlite:///{DB_PATH}"

# 密码加密
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# 小组配置
TEAMS_CONFIG = [
    {"code": "wj", "name": "文俊组"},
    {"code": "jy", "name": ""},  # 待输入
    {"code": "yz", "name": ""},  # 待输入
]

# 账号配置
ACCOUNTS_CONFIG = {
    "manager": {
        "password": "m123456",
        "role": "manager",
        "team": None,
        "display_name": "经理",
        "old_username": "wenjun123"  # 从这个账号迁移
    },
    # 组长
    "wjzu": {"password": "wj123456", "role": "leader", "team": "wj", "display_name": "wj组长"},
    "jyzu": {"password": "jy123456", "role": "leader", "team": "jy", "display_name": "jy组长"},
    "yzzu": {"password": "yz123456", "role": "leader", "team": "yz", "display_name": "yz组长"},
}

# 组员
for i in range(1, 11):
    ACCOUNTS_CONFIG[f"wj{i:02d}"] = {"password": "wj123456", "role": "member", "team": "wj", "display_name": f"wj{i:02d}"}
    ACCOUNTS_CONFIG[f"jy{i:02d}"] = {"password": "jy123456", "role": "member", "team": "jy", "display_name": f"jy{i:02d}"}
    ACCOUNTS_CONFIG[f"yz{i:02d}"] = {"password": "yz123456", "role": "member", "team": "yz", "display_name": f"yz{i:02d}"}


def get_team_names():
    """获取小组中文名 - jy/yz组使用默认名，可稍后在管理页面修改"""
    print("\n小组中文名设置：")
    print(f"  wj组: 文俊组")
    print(f"  jy组: jy组 (可稍后在团队管理页面修改)")
    print(f"  yz组: yz组 (可稍后在团队管理页面修改)")
    
    return {"wj": "文俊组", "jy": "jy组", "yz": "yz组"}


def create_teams_table(conn, dry_run=False):
    """创建 teams 表"""
    print("\n" + "=" * 60)
    print("步骤1: 创建 teams 表")
    print("=" * 60)
    
    inspector = inspect(conn)
    if "teams" in inspector.get_table_names():
        print("  teams 表已存在，跳过创建")
        return True
    
    sql = """
    CREATE TABLE teams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_code VARCHAR(20) UNIQUE NOT NULL,
        team_name VARCHAR(50) NOT NULL,
        leader_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP,
        FOREIGN KEY (leader_id) REFERENCES users(id)
    )
    """
    
    if dry_run:
        print("  [DRY RUN] 将创建 teams 表")
    else:
        conn.execute(text(sql))
        conn.commit()
        print("  ✓ teams 表已创建")
    
    return True


def add_team_id_column(conn, dry_run=False):
    """给 users 表添加 team_id 字段"""
    print("\n" + "=" * 60)
    print("步骤2: 给 users 表添加 team_id 字段")
    print("=" * 60)
    
    # 检查列是否存在
    result = conn.execute(text("PRAGMA table_info(users)"))
    columns = [row[1] for row in result.fetchall()]
    
    if "team_id" in columns:
        print("  team_id 字段已存在，跳过")
        return True
    
    sql = "ALTER TABLE users ADD COLUMN team_id INTEGER REFERENCES teams(id)"
    
    if dry_run:
        print("  [DRY RUN] 将添加 team_id 字段")
    else:
        conn.execute(text(sql))
        conn.commit()
        print("  ✓ team_id 字段已添加")
    
    return True


def update_role_enum(conn, dry_run=False):
    """更新 role 字段支持新角色"""
    print("\n" + "=" * 60)
    print("步骤3: 更新用户角色")
    print("=" * 60)
    
    # SQLite 的 Enum 实际上是字符串，直接支持新值
    print("  SQLite 使用字符串存储角色，无需修改表结构")
    print("  新角色值: manager, leader, member")
    
    return True


def create_teams(conn, team_names, dry_run=False):
    """创建小组"""
    print("\n" + "=" * 60)
    print("步骤4: 创建小组")
    print("=" * 60)
    
    # 先检查 teams 表是否存在
    inspector = inspect(conn)
    if "teams" not in inspector.get_table_names():
        print("  错误: teams 表不存在，请先执行步骤1")
        return False
    
    for code, name in team_names.items():
        # 检查是否已存在
        try:
            result = conn.execute(
                text("SELECT id FROM teams WHERE team_code = :code"),
                {"code": code}
            )
            if result.fetchone():
                print(f"  {code}组 ({name}) 已存在，跳过")
                continue
        except Exception as e:
            print(f"  检查小组 {code} 时出错: {e}")
        
        if dry_run:
            print(f"  [DRY RUN] 将创建小组: {code} - {name}")
        else:
            conn.execute(
                text("INSERT INTO teams (team_code, team_name) VALUES (:code, :name)"),
                {"code": code, "name": name}
            )
            conn.commit()
            print(f"  ✓ 创建小组: {code} - {name}")
    
    return True


def get_team_id_map(conn):
    """获取 team_code -> team_id 映射"""
    result = conn.execute(text("SELECT id, team_code FROM teams"))
    return {row[1]: row[0] for row in result.fetchall()}


def migrate_manager_account(conn, dry_run=False):
    """迁移经理账号 wenjun123 -> manager"""
    print("\n" + "=" * 60)
    print("步骤5: 迁移经理账号")
    print("=" * 60)
    
    # 检查 wenjun123 是否存在
    result = conn.execute(text("SELECT id FROM users WHERE username = 'wenjun123'"))
    old_user = result.fetchone()
    
    # 检查 manager 是否已存在
    result = conn.execute(text("SELECT id FROM users WHERE username = 'manager'"))
    new_user = result.fetchone()
    
    if new_user:
        print("  manager 账号已存在，跳过迁移")
        return True
    
    password_hash = pwd_context.hash("m123456")
    
    if old_user:
        # 重命名 wenjun123 -> manager
        if dry_run:
            print(f"  [DRY RUN] 将重命名 wenjun123 -> manager")
        else:
            conn.execute(
                text("""
                    UPDATE users 
                    SET username = 'manager', 
                        password_hash = :password,
                        role = 'manager',
                        display_name = '经理',
                        team_id = NULL
                    WHERE username = 'wenjun123'
                """),
                {"password": password_hash}
            )
            conn.commit()
            print(f"  ✓ wenjun123 已重命名为 manager，密码已更新")
    else:
        # 创建新的 manager 账号
        if dry_run:
            print(f"  [DRY RUN] wenjun123 不存在，将创建新 manager 账号")
        else:
            conn.execute(
                text("""
                    INSERT INTO users (username, password_hash, role, display_name, team_id)
                    VALUES ('manager', :password, 'manager', '经理', NULL)
                """),
                {"password": password_hash}
            )
            conn.commit()
            print(f"  ✓ 创建新 manager 账号")
    
    return True


def create_or_update_accounts(conn, team_id_map, dry_run=False):
    """创建或更新账号"""
    print("\n" + "=" * 60)
    print("步骤6: 创建/更新账号")
    print("=" * 60)
    
    created_count = 0
    updated_count = 0
    skipped_count = 0
    
    for username, config in ACCOUNTS_CONFIG.items():
        if username == "manager":
            continue  # 经理账号已在步骤5处理
        
        team_code = config.get("team")
        team_id = team_id_map.get(team_code) if team_code else None
        password_hash = pwd_context.hash(config["password"])
        role = config["role"]
        display_name = config.get("display_name", username)
        
        # 检查用户是否存在
        result = conn.execute(
            text("SELECT id, role FROM users WHERE username = :username"),
            {"username": username}
        )
        existing = result.fetchone()
        
        if existing:
            # 更新现有用户
            if dry_run:
                print(f"  [DRY RUN] 将更新 {username}: role={role}, team={team_code}")
            else:
                conn.execute(
                    text("""
                        UPDATE users 
                        SET password_hash = :password,
                            role = :role,
                            team_id = :team_id,
                            display_name = :display_name
                        WHERE username = :username
                    """),
                    {
                        "password": password_hash,
                        "role": role,
                        "team_id": team_id,
                        "display_name": display_name,
                        "username": username
                    }
                )
                updated_count += 1
        else:
            # 创建新用户
            if dry_run:
                print(f"  [DRY RUN] 将创建 {username}: role={role}, team={team_code}")
            else:
                conn.execute(
                    text("""
                        INSERT INTO users (username, password_hash, role, team_id, display_name)
                        VALUES (:username, :password, :role, :team_id, :display_name)
                    """),
                    {
                        "username": username,
                        "password": password_hash,
                        "role": role,
                        "team_id": team_id,
                        "display_name": display_name
                    }
                )
                created_count += 1
    
    if not dry_run:
        conn.commit()
    
    print(f"\n  创建: {created_count} 个账号")
    print(f"  更新: {updated_count} 个账号")
    
    return True


def set_team_leaders(conn, team_id_map, dry_run=False):
    """设置组长"""
    print("\n" + "=" * 60)
    print("步骤7: 设置组长")
    print("=" * 60)
    
    leader_map = {
        "wj": "wjzu",
        "jy": "jyzu",
        "yz": "yzzu"
    }
    
    for team_code, leader_username in leader_map.items():
        team_id = team_id_map.get(team_code)
        if not team_id:
            print(f"  警告: 找不到小组 {team_code}")
            continue
        
        # 获取组长 user_id
        result = conn.execute(
            text("SELECT id FROM users WHERE username = :username"),
            {"username": leader_username}
        )
        leader = result.fetchone()
        
        if not leader:
            print(f"  警告: 找不到组长账号 {leader_username}")
            continue
        
        leader_id = leader[0]
        
        if dry_run:
            print(f"  [DRY RUN] 将设置 {team_code}组 组长为 {leader_username}")
        else:
            conn.execute(
                text("UPDATE teams SET leader_id = :leader_id WHERE id = :team_id"),
                {"leader_id": leader_id, "team_id": team_id}
            )
            conn.commit()
            print(f"  ✓ {team_code}组 组长: {leader_username}")
    
    return True


def print_summary(conn):
    """打印迁移总结"""
    print("\n" + "=" * 60)
    print("迁移总结")
    print("=" * 60)
    
    # 统计小组
    result = conn.execute(text("SELECT team_code, team_name FROM teams ORDER BY team_code"))
    teams = result.fetchall()
    print(f"\n小组 ({len(teams)} 个):")
    for team in teams:
        print(f"  - {team[0]}: {team[1]}")
    
    # 统计用户
    result = conn.execute(text("""
        SELECT u.role, COUNT(*) as cnt 
        FROM users u 
        GROUP BY u.role
    """))
    roles = result.fetchall()
    print(f"\n用户角色统计:")
    for role in roles:
        print(f"  - {role[0]}: {role[1]} 人")
    
    # 按小组统计
    result = conn.execute(text("""
        SELECT t.team_code, t.team_name, COUNT(u.id) as member_count
        FROM teams t
        LEFT JOIN users u ON u.team_id = t.id
        GROUP BY t.id
        ORDER BY t.team_code
    """))
    team_stats = result.fetchall()
    print(f"\n各小组人数:")
    for stat in team_stats:
        print(f"  - {stat[0]}组 ({stat[1]}): {stat[2]} 人")


def main():
    parser = argparse.ArgumentParser(description="团队架构迁移脚本")
    parser.add_argument("--dry-run", action="store_true", help="预览模式，不实际修改")
    args = parser.parse_args()
    
    print("=" * 60)
    print("团队架构迁移脚本")
    print("=" * 60)
    print(f"数据库: {DB_PATH}")
    print(f"模式: {'预览 (DRY RUN)' if args.dry_run else '正式执行'}")
    
    # 获取小组中文名
    if not args.dry_run:
        team_names = get_team_names()
    else:
        team_names = {"wj": "文俊组", "jy": "jy组(待输入)", "yz": "yz组(待输入)"}
    
    print(f"\n小组配置:")
    for code, name in team_names.items():
        print(f"  {code}: {name}")
    
    # 连接数据库
    engine = create_engine(DATABASE_URL)
    
    with engine.connect() as conn:
        # 执行迁移步骤
        create_teams_table(conn, args.dry_run)
        add_team_id_column(conn, args.dry_run)
        update_role_enum(conn, args.dry_run)
        create_teams(conn, team_names, args.dry_run)
        
        # 获取 team_id 映射
        if not args.dry_run:
            team_id_map = get_team_id_map(conn)
        else:
            team_id_map = {"wj": 1, "jy": 2, "yz": 3}  # 模拟
        
        migrate_manager_account(conn, args.dry_run)
        create_or_update_accounts(conn, team_id_map, args.dry_run)
        set_team_leaders(conn, team_id_map, args.dry_run)
        
        if not args.dry_run:
            print_summary(conn)
    
    print("\n" + "=" * 60)
    if args.dry_run:
        print("预览完成！使用 python migrate_teams.py 执行迁移")
    else:
        print("迁移完成！")
    print("=" * 60)


if __name__ == "__main__":
    main()

