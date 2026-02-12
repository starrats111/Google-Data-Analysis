"""
修复脚本：查找并修复MID缺失的交易记录
"""
import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from datetime import date, timedelta
from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_transaction import AffiliateTransaction
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.services.collabglow_service import CollabGlowService
import json

def diagnose_and_fix_missing_mid():
    db = SessionLocal()
    
    print("=" * 80)
    print("MID缺失修复脚本")
    print("=" * 80)
    
    # 定义日期范围（本月）
    today = date.today()
    month_start = date(today.year, today.month, 1)
    
    # 查找所有MID缺失的记录
    missing_records = db.query(AffiliateTransaction).filter(
        AffiliateTransaction.transaction_time >= month_start,
        AffiliateTransaction.merchant_id == None
    ).all()
    
    print(f"\n找到 {len(missing_records)} 条MID缺失的记录")
    
    if not missing_records:
        print("没有需要修复的记录 ✅")
        db.close()
        return
    
    # 分析每条记录
    print("\n" + "-" * 80)
    print("分析缺失记录:")
    print("-" * 80)
    
    fixed_count = 0
    
    for tx in missing_records:
        user = db.query(User).filter(User.id == tx.user_id).first()
        username = user.username if user else f"ID:{tx.user_id}"
        
        print(f"\n[{username}] {tx.platform.upper()}")
        print(f"  商家: {tx.merchant}")
        print(f"  交易ID: {tx.transaction_id}")
        print(f"  时间: {tx.transaction_time}")
        
        # 尝试从商家名中提取MID
        # 有些平台的商家名格式可能包含ID，如 "MerchantName (12345)"
        merchant_name = tx.merchant or ""
        
        # 方法1：检查是否有括号中的数字
        import re
        bracket_match = re.search(r'\((\d{4,})\)', merchant_name)
        if bracket_match:
            extracted_mid = bracket_match.group(1)
            print(f"  从商家名括号中提取: {extracted_mid}")
            tx.merchant_id = extracted_mid
            fixed_count += 1
            continue
        
        # 方法2：对于CG平台，尝试重新从API获取
        if tx.platform.lower() == 'cg':
            # 获取用户的CG账号
            cg_platform = db.query(AffiliatePlatform).filter(
                AffiliatePlatform.platform_name == 'CG'
            ).first()
            
            if cg_platform:
                cg_account = db.query(AffiliateAccount).filter(
                    AffiliateAccount.user_id == tx.user_id,
                    AffiliateAccount.platform_id == cg_platform.id,
                    AffiliateAccount.is_active == True
                ).first()
                
                if cg_account and cg_account.notes:
                    try:
                        notes = json.loads(cg_account.notes)
                        token = notes.get('collabglow_token') or notes.get('cg_token') or notes.get('api_token') or notes.get('token')
                        
                        if token:
                            # 调用CG API获取该交易的详情
                            service = CollabGlowService(token)
                            tx_date = tx.transaction_time.strftime("%Y-%m-%d")
                            result = service.get_transactions(tx_date, tx_date)
                            
                            # CG返回格式: {"success": True, "data": {"transactions": [...]}}
                            data = result.get('data', {})
                            transactions = data.get('transactions', []) or data.get('list', [])
                            
                            print(f"  API返回 {len(transactions)} 条交易")
                            
                            if not transactions:
                                print(f"  API返回数据为空，尝试打印完整结果:")
                                print(f"  {result}")
                            
                            # 先尝试通过交易ID匹配
                            found = False
                            for api_tx in transactions:
                                api_order_id = api_tx.get('orderId') or api_tx.get('order_id') or api_tx.get('transactionId') or api_tx.get('transaction_id')
                                if str(api_order_id) == str(tx.transaction_id):
                                    found = True
                                    brand_id = api_tx.get('brandId') or api_tx.get('brand_id') or api_tx.get('mid')
                                    if brand_id:
                                        print(f"  ✅ 通过交易ID匹配: brandId={brand_id}")
                                        tx.merchant_id = str(brand_id).strip()
                                        fixed_count += 1
                                    break
                            
                            # 如果交易ID匹配失败，尝试通过商家名匹配
                            if not found:
                                merchant_lower = (tx.merchant or "").lower().strip()
                                for api_tx in transactions:
                                    api_merchant = (api_tx.get('merchantName') or api_tx.get('merchant_name') or api_tx.get('merchant') or api_tx.get('brand') or "").lower().strip()
                                    if merchant_lower and api_merchant and merchant_lower in api_merchant or api_merchant in merchant_lower:
                                        brand_id = api_tx.get('brandId') or api_tx.get('brand_id') or api_tx.get('mid')
                                        if brand_id:
                                            print(f"  ✅ 通过商家名匹配 [{api_merchant}]: brandId={brand_id}")
                                            tx.merchant_id = str(brand_id).strip()
                                            fixed_count += 1
                                            found = True
                                            break
                            
                            if not found:
                                print(f"  未找到匹配 (交易ID: {tx.transaction_id}, 商家: {tx.merchant})")
                                # 打印API返回的商家名列表帮助调试
                                merchants_in_api = set()
                                for t in transactions:
                                    m = t.get('merchantName') or t.get('merchant_name') or t.get('merchant') or t.get('brand')
                                    if m:
                                        merchants_in_api.add(m.lower())
                                print(f"  API返回的商家名: {list(merchants_in_api)[:10]}")
                    except Exception as e:
                        import traceback
                        print(f"  处理异常: {e}")
                        traceback.print_exc()
        
        # 如果还是没有MID，标记为需要手动处理
        if not tx.merchant_id:
            print(f"  ⚠️ 无法自动修复，可能需要手动处理")
    
    # 提交修复
    if fixed_count > 0:
        db.commit()
        print(f"\n✅ 已修复 {fixed_count} 条记录")
    else:
        print(f"\n⚠️ 没有自动修复的记录")
    
    # 对于无法自动修复的，尝试从商家名推断
    print("\n" + "=" * 80)
    print("尝试从商家名映射MID...")
    print("=" * 80)
    
    # 重新查询仍然缺失的记录
    still_missing = db.query(AffiliateTransaction).filter(
        AffiliateTransaction.transaction_time >= month_start,
        AffiliateTransaction.merchant_id == None
    ).all()
    
    if still_missing:
        print(f"\n仍有 {len(still_missing)} 条记录缺失MID:")
        
        # 查找同商家名有MID的记录
        for tx in still_missing:
            # 查找同商家名的其他记录
            same_merchant = db.query(AffiliateTransaction).filter(
                AffiliateTransaction.merchant == tx.merchant,
                AffiliateTransaction.merchant_id != None
            ).first()
            
            if same_merchant:
                print(f"  [{tx.merchant}] 从同商家记录获取: MID={same_merchant.merchant_id}")
                tx.merchant_id = same_merchant.merchant_id
                fixed_count += 1
            else:
                print(f"  [{tx.merchant}] 未找到同商家的MID记录")
        
        if fixed_count > 0:
            db.commit()
            print(f"\n✅ 通过商家名映射修复了记录")
    
    # 最终检查
    final_missing = db.query(AffiliateTransaction).filter(
        AffiliateTransaction.transaction_time >= month_start,
        AffiliateTransaction.merchant_id == None
    ).count()
    
    print("\n" + "=" * 80)
    print("修复完成")
    print("=" * 80)
    print(f"修复前缺失: {len(missing_records)} 条")
    print(f"修复后缺失: {final_missing} 条")
    print(f"成功修复: {len(missing_records) - final_missing} 条")
    
    db.close()

if __name__ == "__main__":
    diagnose_and_fix_missing_mid()

