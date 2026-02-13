"""
修复 LinkHaiTao 交易的 merchant_id
将 slug 格式（如 hotelcollectiona）更新为数字 ID 格式（如 154253）

需要先调用 LH API 获取 mcid -> m_id 的映射关系
"""
import sys
sys.path.insert(0, '/home/admin/Google-Data-Analysis/backend')

import requests
import json
from datetime import datetime
from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.affiliate_transaction import AffiliateTransaction

db = SessionLocal()

print("=" * 70)
print("修复 LinkHaiTao 交易的 merchant_id")
print("=" * 70)

# 获取所有 LH 平台账号
lh_platform = db.query(AffiliatePlatform).filter(AffiliatePlatform.platform_code == "lh").first()
if not lh_platform:
    print("错误: 找不到 LH 平台")
    sys.exit(1)

lh_accounts = db.query(AffiliateAccount).filter(
    AffiliateAccount.platform_id == lh_platform.id
).all()

print(f"找到 {len(lh_accounts)} 个 LH 账号")

# 对每个账号，调用 API 获取 mcid -> m_id 映射
for account in lh_accounts:
    user = db.query(User).filter(User.id == account.user_id).first()
    print(f"\n处理账号: {account.account_name} (用户: {user.username if user else 'N/A'})")
    
    # 获取 token
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
    
    # 调用 LH API 获取订单数据
    api_url = "https://www.linkhaitao.com/api.php?mod=medium&op=cashback2"
    params = {
        "token": token,
        "begin_date": "2026-02-01",
        "end_date": "2026-02-13",
        "page": 1,
        "per_page": 40000,
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
        
        print(f"  API 返回 {len(orders)} 条订单")
        
        # 构建 mcid -> m_id 映射
        mcid_to_mid = {}
        for order in orders:
            mcid = order.get("mcid")
            m_id = order.get("m_id")
            if mcid and m_id and mcid not in mcid_to_mid:
                mcid_to_mid[mcid] = str(m_id)
        
        print(f"  映射关系: {mcid_to_mid}")
        
        # 更新数据库中的 merchant_id
        updated_count = 0
        for mcid, m_id in mcid_to_mid.items():
            # 查找该账号下 merchant_id 为 mcid 的交易
            transactions = db.query(AffiliateTransaction).filter(
                AffiliateTransaction.affiliate_account_id == account.id,
                AffiliateTransaction.platform == "lh",
                AffiliateTransaction.merchant_id == mcid
            ).all()
            
            if transactions:
                print(f"    更新 {len(transactions)} 条交易: {mcid} -> {m_id}")
                for t in transactions:
                    t.merchant_id = m_id
                    t.updated_at = datetime.now()
                updated_count += len(transactions)
        
        if updated_count > 0:
            db.commit()
            print(f"  共更新 {updated_count} 条交易")
        else:
            print(f"  无需更新")
            
    except Exception as e:
        print(f"  错误: {e}")
        continue

db.close()
print("\n" + "=" * 70)
print("修复完成!")
print("=" * 70)

