"""
针对 LH 和 LB 平台触发全量缓存同步
"""
import paramiko
import time
import textwrap

SERVER = "47.239.193.33"
USER = "admin"
PASS = "A123456"
PROJECT = "/home/admin/Google-Data-Analysis"

def ssh_exec(ssh, cmd, timeout=300):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    return out, err

def main():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(SERVER, username=USER, password=PASS, timeout=15)
    print("=== SSH 连接成功 ===\n")

    sync_script = textwrap.dedent(r'''
import sys, os, json, time
sys.path.insert(0, "/home/admin/Google-Data-Analysis/backend")
os.chdir("/home/admin/Google-Data-Analysis/backend")

from app.database import SessionLocal
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.campaign_link_cache import CampaignLinkCache
from app.models.user import User
from app.services.merchant_platform_sync import MerchantPlatformSyncService, PLATFORM_API_CONFIG
from app.services.campaign_link_sync_service import CampaignLinkSyncService
from sqlalchemy import func
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

db = SessionLocal()

# 先确认当前配置
print("=" * 60)
print("当前 LH 配置:", json.dumps({k: v for k, v in PLATFORM_API_CONFIG["LH"].items()}, ensure_ascii=False))
print("当前 LB 配置:", json.dumps({k: v for k, v in PLATFORM_API_CONFIG["LB"].items()}, ensure_ascii=False))
print("=" * 60)

# 获取所有用户
users = db.query(User).all()
sync_service = CampaignLinkSyncService(db)

target_platforms = ["LH", "LB"]

for platform in target_platforms:
    print(f"\n{'=' * 60}")
    print(f"开始同步平台: {platform}")
    print(f"{'=' * 60}")
    
    # 找到有此平台账号的用户
    accounts = (
        db.query(AffiliateAccount, AffiliatePlatform, User)
        .join(AffiliatePlatform)
        .join(User, AffiliateAccount.user_id == User.id)
        .filter(
            AffiliateAccount.is_active.is_(True),
            func.upper(AffiliatePlatform.platform_code) == platform,
        )
        .all()
    )
    
    if not accounts:
        print(f"  无 {platform} 账号!")
        continue
    
    print(f"  找到 {len(accounts)} 个 {platform} 账号")
    
    for acct, plat, user in accounts:
        token = MerchantPlatformSyncService._resolve_token(acct, platform)
        if not token:
            print(f"  用户 {user.username} (ID={user.id}) 账号 {acct.account_name}: 无 Token，跳过")
            continue
        
        print(f"\n  同步用户 {user.username} (ID={user.id}) 账号 {acct.account_name}...")
        try:
            count = sync_service._sync_platform(user.id, platform, token)
            print(f"    => 缓存 {count} 条")
        except Exception as e:
            print(f"    => 失败: {e}")
            import traceback
            traceback.print_exc()

# 验证结果
print(f"\n{'=' * 60}")
print("同步后缓存状态:")
print(f"{'=' * 60}")
platforms = db.query(
    CampaignLinkCache.platform_code,
    func.count(CampaignLinkCache.id)
).group_by(CampaignLinkCache.platform_code).all()
for p, c in sorted(platforms, key=lambda x: x[0]):
    print(f"  {p}: {c} 条")

# LH/LB 细分到用户
for platform in target_platforms:
    print(f"\n  [{platform}] 各用户缓存:")
    user_counts = db.query(
        CampaignLinkCache.user_id,
        func.count(CampaignLinkCache.id)
    ).filter(
        CampaignLinkCache.platform_code == platform
    ).group_by(CampaignLinkCache.user_id).all()
    
    if not user_counts:
        print(f"    无数据")
    for uid, cnt in user_counts:
        u = db.query(User).get(uid)
        name = u.username if u else f"ID={uid}"
        print(f"    {name}: {cnt} 条")

db.close()
print("\n=== 同步完成 ===")
''')

    ssh.exec_command(f"cat > /tmp/sync_lh_lb.py << 'PYEOF'\n{sync_script}\nPYEOF")
    time.sleep(1)

    print("正在触发 LH/LB 全量同步（可能需要几分钟）...")
    out, err = ssh_exec(ssh, f"cd {PROJECT}/backend && source venv/bin/activate && python3 /tmp/sync_lh_lb.py", timeout=600)
    
    if out:
        print(out)
    if err:
        err_lines = [l for l in err.split("\n") if l.strip() and "WARNING" not in l]
        if err_lines:
            print("STDERR (filtered):", "\n".join(err_lines[-20:]))
    
    ssh.close()

if __name__ == "__main__":
    main()
