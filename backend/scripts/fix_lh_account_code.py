"""
修复 LH 平台 affiliate_accounts 表的 account_code
将 slug 格式（如 hotelcollections）更新为数字 m_id 格式（如 154253）
使其与广告系列名中提取的 MID 一致，解决 L7D 分析匹配失败问题

用法: cd ~/Google-Data-Analysis/backend && source venv/bin/activate && python scripts/fix_lh_account_code.py
"""
import sys
sys.path.insert(0, '/home/admin/Google-Data-Analysis/backend')

import requests
import json
from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform

db = SessionLocal()

print("=" * 70)
print("修复 LH 账号的 account_code（slug -> 数字 m_id）")
print("=" * 70)

lh_platform = db.query(AffiliatePlatform).filter(AffiliatePlatform.platform_code == "lh").first()
if not lh_platform:
    print("错误: 找不到 LH 平台")
    sys.exit(1)

lh_accounts = db.query(AffiliateAccount).filter(
    AffiliateAccount.platform_id == lh_platform.id
).all()

print(f"找到 {len(lh_accounts)} 个 LH 账号\n")

updated_total = 0

for account in lh_accounts:
    user = db.query(User).filter(User.id == account.user_id).first()
    username = user.username if user else "N/A"
    print(f"账号: {account.account_name} (用户: {username}, 当前 account_code: {account.account_code})")

    # 如果 account_code 已经是纯数字，跳过
    if account.account_code and account.account_code.isdigit():
        print(f"  已是数字 ID，跳过\n")
        continue

    # 获取 token
    token = None
    if account.notes:
        try:
            notes_data = json.loads(account.notes)
            token = notes_data.get("linkhaitao_token") or notes_data.get("api_token") or notes_data.get("token")
        except:
            pass

    if not token:
        print(f"  跳过: 未找到 Token\n")
        continue

    # 调用 LH API 获取订单数据，提取 mcid -> m_id 映射
    api_url = "https://www.linkhaitao.com/api.php?mod=medium&op=cashback2"
    params = {
        "token": token,
        "begin_date": "2026-01-01",
        "end_date": "2026-02-26",
        "page": 1,
        "per_page": 100,
        "status": "all"
    }

    try:
        response = requests.post(api_url, data=params, timeout=60)
        response.raise_for_status()
        data = response.json()

        orders_data = data.get("data", [])
        if isinstance(orders_data, dict):
            orders = orders_data.get("list", [])
        else:
            orders = orders_data

        # 构建 mcid -> m_id 映射
        mcid_to_mid = {}
        for order in orders:
            mcid = order.get("mcid")
            m_id = order.get("m_id")
            if mcid and m_id:
                mcid_to_mid[str(mcid).strip()] = str(m_id).strip()

        if not mcid_to_mid:
            print(f"  API 返回 {len(orders)} 条订单，但未找到 mcid->m_id 映射\n")
            continue

        print(f"  映射关系: {mcid_to_mid}")

        # 检查当前 account_code 是否在映射中
        old_code = (account.account_code or "").strip()
        if old_code in mcid_to_mid:
            new_code = mcid_to_mid[old_code]
            print(f"  [修复] account_code: \"{old_code}\" -> \"{new_code}\"")
            account.account_code = new_code
            updated_total += 1
        else:
            # 尝试模糊匹配（去掉尾部 s 等微小差异）
            matched = False
            for mcid, m_id in mcid_to_mid.items():
                if old_code.rstrip("s") == mcid.rstrip("s") or mcid.rstrip("s") == old_code.rstrip("s"):
                    print(f"  [模糊修复] account_code: \"{old_code}\" -> \"{m_id}\" (匹配 mcid: {mcid})")
                    account.account_code = m_id
                    updated_total += 1
                    matched = True
                    break
            if not matched:
                print(f"  未找到 \"{old_code}\" 的映射，可用映射: {mcid_to_mid}")

    except Exception as e:
        print(f"  错误: {e}")

    print()

if updated_total > 0:
    db.commit()
    print(f"共修复 {updated_total} 个账号的 account_code")
else:
    print("无需修复")

db.close()
print("=" * 70)
print("完成!")
print("=" * 70)
