"""
全量修复 LinkHaiTao 的 MID 问题
1. affiliate_transactions 表：merchant_id 从 slug 修正为纯数字 m_id
2. affiliate_merchants 表：merchant_id 从 slug 修正为纯数字 m_id
3. affiliate_accounts 表：account_code 从 slug 修正为纯数字 m_id

用法: cd ~/Google-Data-Analysis/backend && source venv/bin/activate && python scripts/fix_lh_mid_full.py
"""
import sys
sys.path.insert(0, '/home/admin/Google-Data-Analysis/backend')

import requests
import json
import time
from datetime import datetime
from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.affiliate_transaction import AffiliateTransaction
from app.models.merchant import AffiliateMerchant

db = SessionLocal()

print("=" * 70)
print("全量修复 LinkHaiTao MID（slug → 纯数字 m_id）")
print(f"开始时间: {datetime.now()}")
print("=" * 70)

# ── 第 0 步：获取 LH 平台和账号 ──
lh_platform = db.query(AffiliatePlatform).filter(
    AffiliatePlatform.platform_code == "lh"
).first()
if not lh_platform:
    print("错误: 找不到 LH 平台")
    sys.exit(1)

lh_accounts = db.query(AffiliateAccount).filter(
    AffiliateAccount.platform_id == lh_platform.id
).all()
print(f"找到 {len(lh_accounts)} 个 LH 账号\n")

# ── 第 1 步：通过 merchantBasicList3 API 构建全量 mcid → m_id 映射 ──
print("=" * 70)
print("第 1 步：通过 merchantBasicList3 API 构建 mcid → m_id 映射")
print("=" * 70)

global_mcid_map = {}  # mcid(slug) → m_id(数字)

for account in lh_accounts:
    user = db.query(User).filter(User.id == account.user_id).first()
    username = user.username if user else "N/A"
    print(f"\n账号: {account.account_name} (用户: {username})")

    token = None
    if account.notes:
        try:
            notes_data = json.loads(account.notes)
            token = notes_data.get("linkhaitao_token") or notes_data.get("api_token") or notes_data.get("token")
        except:
            pass

    if not token:
        print(f"  跳过: 未找到 Token")
        continue

    # 调用 merchantBasicList3 获取商家目录
    api_url = "https://www.linkhaitao.com/api.php?mod=medium&op=merchantBasicList3"
    for relationship in ["joined", "notjoined", "applying"]:
        params = {
            "token": token,
            "relationship": relationship,
            "page": 1,
            "per_page": 40000,
        }
        try:
            resp = requests.post(api_url, data=params, timeout=60)
            resp.raise_for_status()
            data = resp.json()

            items = data.get("data", [])
            if isinstance(items, dict):
                items = items.get("list", items.get("data", []))
            if not isinstance(items, list):
                items = []

            count = 0
            for item in items:
                mcid = item.get("mcid")
                m_id = item.get("m_id")
                if mcid and m_id:
                    mcid_str = str(mcid).strip()
                    mid_str = str(m_id).strip()
                    if mid_str.isdigit() and mid_str != "0":
                        global_mcid_map[mcid_str] = mid_str
                        count += 1

            print(f"  {relationship}: {len(items)} 商家, {count} 条有效映射")
        except Exception as e:
            print(f"  {relationship} 错误: {e}")

        time.sleep(0.5)

    # 补充：通过 cashback2 API 获取更多映射（覆盖交易中出现但商家目录中没有的）
    cashback_url = "https://www.linkhaitao.com/api.php?mod=medium&op=cashback2"
    cashback_params = {
        "token": token,
        "begin_date": "2025-01-01",
        "end_date": datetime.now().strftime("%Y-%m-%d"),
        "page": 1,
        "per_page": 40000,
        "status": "all"
    }
    try:
        resp = requests.post(cashback_url, data=cashback_params, timeout=60)
        resp.raise_for_status()
        data = resp.json()

        orders_data = data.get("data", [])
        if isinstance(orders_data, dict):
            orders = orders_data.get("list", [])
        else:
            orders = orders_data

        extra = 0
        for order in orders:
            mcid = order.get("mcid")
            m_id = order.get("m_id")
            if mcid and m_id:
                mcid_str = str(mcid).strip()
                mid_str = str(m_id).strip()
                if mid_str.isdigit() and mid_str != "0" and mcid_str not in global_mcid_map:
                    global_mcid_map[mcid_str] = mid_str
                    extra += 1

        print(f"  cashback2: {len(orders)} 条订单, {extra} 条新增映射")
    except Exception as e:
        print(f"  cashback2 错误: {e}")

    time.sleep(1)

print(f"\n总映射关系: {len(global_mcid_map)} 条")
if len(global_mcid_map) < 5:
    print(f"映射内容: {global_mcid_map}")

# ── 第 2 步：修复 affiliate_transactions 表 ──
print("\n" + "=" * 70)
print("第 2 步：修复 affiliate_transactions 表")
print("=" * 70)

# 查找所有 LH 平台中 merchant_id 非纯数字的交易
all_lh_transactions = db.query(AffiliateTransaction).filter(
    AffiliateTransaction.platform == "lh",
    AffiliateTransaction.merchant_id.isnot(None),
).all()
slug_transactions = [t for t in all_lh_transactions if not t.merchant_id.strip().isdigit()]

print(f"找到 {len(slug_transactions)} 条 merchant_id 为 slug 的交易")

tx_updated = 0
tx_not_found = 0
for tx in slug_transactions:
    old_mid = tx.merchant_id.strip()
    if old_mid in global_mcid_map:
        tx.merchant_id = global_mcid_map[old_mid]
        tx.updated_at = datetime.now()
        tx_updated += 1
    else:
        # 尝试模糊匹配
        matched = False
        for mcid, m_id in global_mcid_map.items():
            if old_mid.lower() == mcid.lower() or old_mid.rstrip("s").lower() == mcid.rstrip("s").lower():
                tx.merchant_id = m_id
                tx.updated_at = datetime.now()
                tx_updated += 1
                matched = True
                break
        if not matched:
            tx_not_found += 1

if tx_updated > 0:
    db.commit()
print(f"已修复 {tx_updated} 条交易, {tx_not_found} 条未找到映射")

# ── 第 3 步：修复 affiliate_merchants 表 ──
print("\n" + "=" * 70)
print("第 3 步：修复 affiliate_merchants 表")
print("=" * 70)

all_lh_merchants = db.query(AffiliateMerchant).filter(
    AffiliateMerchant.platform == "lh",
    AffiliateMerchant.merchant_id.isnot(None),
).all()
slug_merchants = [m for m in all_lh_merchants if not m.merchant_id.strip().isdigit()]

print(f"找到 {len(slug_merchants)} 条 merchant_id 为 slug 的商家记录")

m_updated = 0
m_not_found = 0
m_duplicates = 0
for merchant in slug_merchants:
    old_mid = merchant.merchant_id.strip()
    new_mid = global_mcid_map.get(old_mid)

    # 模糊匹配
    if not new_mid:
        for mcid, m_id in global_mcid_map.items():
            if old_mid.lower() == mcid.lower() or old_mid.rstrip("s").lower() == mcid.rstrip("s").lower():
                new_mid = m_id
                break

    if new_mid:
        # 检查是否已存在相同 platform + merchant_id 的记录（避免唯一约束冲突）
        existing = db.query(AffiliateMerchant).filter(
            AffiliateMerchant.platform == "lh",
            AffiliateMerchant.merchant_id == new_mid,
            AffiliateMerchant.id != merchant.id
        ).first()

        if existing:
            # 已存在正确的记录，删除当前的 slug 记录
            print(f"  重复: {old_mid} → {new_mid} (已存在 id={existing.id}), 删除 slug 记录 id={merchant.id}")
            db.delete(merchant)
            m_duplicates += 1
        else:
            merchant.merchant_id = new_mid
            merchant.missing_mid = 0
            merchant.id_confidence = "api"
            m_updated += 1
    else:
        m_not_found += 1

if m_updated > 0 or m_duplicates > 0:
    db.commit()
print(f"已修复 {m_updated} 条商家, 删除 {m_duplicates} 条重复, {m_not_found} 条未找到映射")

# ── 第 4 步：修复 affiliate_accounts 表 ──
print("\n" + "=" * 70)
print("第 4 步：修复 affiliate_accounts 表 account_code")
print("=" * 70)

ac_updated = 0
for account in lh_accounts:
    old_code = (account.account_code or "").strip()
    if not old_code or old_code.isdigit():
        continue

    new_code = global_mcid_map.get(old_code)
    if not new_code:
        for mcid, m_id in global_mcid_map.items():
            if old_code.lower() == mcid.lower() or old_code.rstrip("s").lower() == mcid.rstrip("s").lower():
                new_code = m_id
                break

    if new_code:
        print(f"  {account.account_name}: {old_code} → {new_code}")
        account.account_code = new_code
        ac_updated += 1
    else:
        print(f"  {account.account_name}: {old_code} 未找到映射")

if ac_updated > 0:
    db.commit()
print(f"已修复 {ac_updated} 个账号的 account_code")

# ── 总结 ──
print("\n" + "=" * 70)
print("修复完成!")
print(f"  映射关系: {len(global_mcid_map)} 条")
print(f"  交易修复: {tx_updated} 条 (未匹配: {tx_not_found})")
print(f"  商家修复: {m_updated} 条 (重复删除: {m_duplicates}, 未匹配: {m_not_found})")
print(f"  账号修复: {ac_updated} 条")
print(f"结束时间: {datetime.now()}")
print("=" * 70)

db.close()
