"""
修复 MCC 账号货币设置
1. 检查所有 MCC 账号的货币设置
2. 自动检测人民币账号（根据邮箱或费用特征）并更新 currency 字段为 CNY
3. 对于已经正确设置的账号，后端会在查询时自动将 CNY 转换为 USD

人民币账号特征：
- 邮箱包含中国域名 (.cn, qq.com, 163.com, 126.com, sina.com 等)
- 或 MCC 名称包含中文
- 或费用值看起来像人民币（较大的数值，例如 > 50 的费用）

使用方法：
  python fix_mcc_currency.py         # 交互模式，需要确认
  python fix_mcc_currency.py --fix   # 直接修复，无需确认
"""
import sys
sys.path.insert(0, '.')

from datetime import date, timedelta
from sqlalchemy import func
from app.database import SessionLocal
from app.models.google_ads_api_data import GoogleMccAccount, GoogleAdsApiData

db = SessionLocal()

# 是否直接修复（无需确认）
auto_fix = '--fix' in sys.argv

# 中国邮箱域名特征
CN_EMAIL_DOMAINS = ['.cn', 'qq.com', '163.com', '126.com', 'sina.com', 'sohu.com', 
                    'aliyun.com', 'foxmail.com', 'yeah.net', 'tom.com']

# 检测是否是中国邮箱
def is_chinese_email(email: str) -> bool:
    if not email:
        return False
    email_lower = email.lower()
    return any(domain in email_lower for domain in CN_EMAIL_DOMAINS)

# 检测是否包含中文字符
def has_chinese_chars(text: str) -> bool:
    if not text:
        return False
    return any('\u4e00' <= char <= '\u9fff' for char in text)

print("=" * 70)
print("MCC 账号货币设置检查与修复")
print("=" * 70)

# 获取所有 MCC 账号
mcc_accounts = db.query(GoogleMccAccount).all()

print(f"\n共找到 {len(mcc_accounts)} 个 MCC 账号\n")

needs_update = []
already_correct = []

for mcc in mcc_accounts:
    current_currency = mcc.currency or 'USD'
    
    # 检测是否应该是 CNY
    should_be_cny = False
    reason = ""
    
    # 1. 检查邮箱
    if is_chinese_email(mcc.email):
        should_be_cny = True
        reason = f"邮箱包含中国域名: {mcc.email}"
    
    # 2. 检查 MCC 名称是否包含中文
    if has_chinese_chars(mcc.mcc_name):
        should_be_cny = True
        reason = f"名称包含中文: {mcc.mcc_name}"
    
    # 3. 检查最近30天的费用数据，看是否像人民币
    if not should_be_cny:
        end_date = date.today()
        begin_date = end_date - timedelta(days=30)
        
        # 获取该 MCC 最近的费用数据
        recent_costs = db.query(
            func.avg(GoogleAdsApiData.cost).label('avg_cost'),
            func.max(GoogleAdsApiData.cost).label('max_cost'),
            func.sum(GoogleAdsApiData.cost).label('total_cost'),
            func.count(GoogleAdsApiData.id).label('count')
        ).filter(
            GoogleAdsApiData.mcc_id == mcc.id,
            GoogleAdsApiData.date >= begin_date,
            GoogleAdsApiData.date <= end_date,
            GoogleAdsApiData.cost > 0
        ).first()
        
        if recent_costs and recent_costs.avg_cost:
            avg_cost = float(recent_costs.avg_cost or 0)
            max_cost = float(recent_costs.max_cost or 0)
            total_cost = float(recent_costs.total_cost or 0)
            
            # 如果平均费用 > 15 且总费用 > 100，可能是人民币
            # （因为正常的美元广告单次费用很少超过 $15）
            if avg_cost > 15 and total_cost > 100:
                should_be_cny = True
                reason = f"费用数据特征 (平均: {avg_cost:.2f}, 总计: {total_cost:.2f})"
    
    # 显示状态
    expected_currency = 'CNY' if should_be_cny else 'USD'
    status_icon = "✅" if current_currency == expected_currency else "❌"
    
    print(f"{status_icon} MCC: {mcc.mcc_name}")
    print(f"    邮箱: {mcc.email}")
    print(f"    当前货币: {current_currency}")
    print(f"    预期货币: {expected_currency}")
    if reason:
        print(f"    判断依据: {reason}")
    
    if current_currency != expected_currency:
        needs_update.append((mcc, expected_currency, reason))
        print(f"    ⚠️ 需要更新为 {expected_currency}")
    else:
        already_correct.append(mcc)
    print()

print("=" * 70)
print(f"检查完成：{len(already_correct)} 个正确，{len(needs_update)} 个需要更新")
print("=" * 70)

if needs_update:
    print("\n需要更新的账号：")
    for mcc, new_currency, reason in needs_update:
        print(f"  - {mcc.mcc_name} ({mcc.email}): {mcc.currency or 'NULL'} → {new_currency}")
    
    if auto_fix:
        confirm = 'y'
        print("\n[自动修复模式] 正在执行更新...")
    else:
        confirm = input("\n是否执行更新？(y/n): ").strip().lower()
    
    if confirm == 'y':
        for mcc, new_currency, reason in needs_update:
            old_currency = mcc.currency
            mcc.currency = new_currency
            print(f"  ✅ 已更新 {mcc.mcc_name}: {old_currency} → {new_currency}")
        
        db.commit()
        print("\n✅ 所有更新已保存！")
        print("后端会自动将 CNY 费用转换为 USD 显示（汇率 7.2）")
    else:
        print("\n❌ 已取消更新")
else:
    print("\n✅ 所有 MCC 账号的货币设置都正确！")

db.close()

