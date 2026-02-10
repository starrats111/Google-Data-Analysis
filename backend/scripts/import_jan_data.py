"""
从Excel导入2026年1月份数据到数据库

数据来源：excel/2026年丰度收支统计表.xlsx
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datetime import date, datetime
from decimal import Decimal
from sqlalchemy import text
from app.database import SessionLocal
from app.models.user import User
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.affiliate_transaction import AffiliateTransaction

db = SessionLocal()

# 员工姓名对照表
EMPLOYEE_MAP = {
    '吴含雪': 'wj01',
    '朱于森': 'wj02',
    '梅雯慧': 'wj03',
    '齐满艳': 'wj04',
    '陈正深': 'wj05',
    '齐青青': 'wj06',
    '朱文欣': 'wj07',
    '张耀虹': 'wj08',  # 已离职，改为8号机
    '8号机': 'wj08',
    '胡雪茜': 'wj09',
    '蓝晨馨': 'wj10',
}

# 平台代码映射
PLATFORM_MAP = {
    'RW': 'RW',
    'LH': 'LH',
    'CG': 'CG',
    'LB': 'LB',
    'PM': 'PM',
    'CF': 'CF',
    'BSH': 'BSH',
}

# 从Excel提取的1月份数据
# 格式: {员工: {广告费, 平台数据: {平台: {账号: {账面佣金, 失效佣金}}}}}
JAN_DATA = {
    'wj01': {
        'ad_cost': 717.59,
        'ad_cost_cny': 8297.92,  # 人民币广告费
        'active_campaigns': 25,
        'platforms': {
            'LH': {'weili': {'book': 3446.04, 'rejected': 51.86}},
            'CG': {'tuancha': {'book': 466.11, 'rejected': 3.37}},
            'BSH': {'bloomroots': {'book': 167.15, 'rejected': 14.41}},
        }
    },
    'wj02': {
        'ad_cost': 2835.38,
        'ad_cost_cny': 0,
        'active_campaigns': 23,
        'platforms': {
            'LH': {'wenjun1': {'book': 2029.23, 'rejected': 570}},
            'CG': {'wenjun3': {'book': 3554.46, 'rejected': 62.45}},
        }
    },
    'wj03': {
        'ad_cost': 638.69,
        'ad_cost_cny': 2905.83,
        'active_campaigns': 28,
        'platforms': {
            'LH': {'wenjun03': {'book': 153.88, 'rejected': 2.5}},
            'CG': {'tuancha': {'book': 1717.92, 'rejected': 307.41}},
            'LB': {'novanest': {'book': 85.02, 'rejected': 0}},
            'CF': {'allurahub': {'book': 87.58, 'rejected': 31.38}},
        }
    },
    'wj04': {
        'ad_cost': 3410,
        'ad_cost_cny': 0,
        'active_campaigns': 17,
        'platforms': {
            'LH': {'wenjun': {'book': 689, 'rejected': 69}},
            'LB': {'weilixia': {'book': 6945.96, 'rejected': 229.1}},
        }
    },
    'wj05': {
        'ad_cost': 2217,
        'ad_cost_cny': 8667,
        'active_campaigns': 31,
        'platforms': {
            'LH': {'everydayhaven': {'book': 984.55, 'rejected': 978.96}},
            'CG': {'kagetsu': {'book': 4881.99, 'rejected': 1027.53}},
            'PM': {'vitahaven': {'book': 155.52, 'rejected': 0}},
        }
    },
    'wj06': {
        'ad_cost': 1637.75,
        'ad_cost_cny': 0,
        'active_campaigns': 30,
        'platforms': {
            'LH': {'kaizenflowshop': {'book': 840.32, 'rejected': 0}},
            'CG': {'wenjun2': {'book': 2919.4, 'rejected': 45.24}},
            'PM': {'everydayhaven': {'book': 70.44, 'rejected': 70.44}},  # Note: 失效佣金数据需确认
            'CF': {'everydayhaven': {'book': 218.45, 'rejected': 97.49}},  # 这可能是不同账号
        }
    },
    'wj07': {
        'ad_cost': 372.17,
        'ad_cost_cny': 0,
        'active_campaigns': 4,
        'platforms': {
            # RW的3个账号合并为wenjun
            'RW': {'wenjun': {'book': 1964.94 + 307.15 + 420.24, 'rejected': 443.7 + 104.72 + 4.48}},
            'LH': {'wenjun3': {'book': 0, 'rejected': 0}},  # 根据Excel数据
            'CG': {'allurahub': {'book': 0, 'rejected': 0}},
        }
    },
    'wj08': {
        'ad_cost': 1227.69,
        'ad_cost_cny': 0,
        'active_campaigns': 38,
        'platforms': {
            'LH': {'wenjun2': {'book': 815.34, 'rejected': 321.66}},
            'CG': {'tuancha': {'book': 0, 'rejected': 0}},
            'LB': {'bloomroots': {'book': 2726.32, 'rejected': 91.27}},
            'PM': {'tuancha': {'book': 77.99, 'rejected': 0}},
        }
    },
    'wj09': {
        'ad_cost': 1211.95,
        'ad_cost_cny': 0,
        'active_campaigns': 26,
        'platforms': {
            'LH': {'everydayhaven': {'book': 1119.58, 'rejected': 106.5}},
            'CG': {'weilixia': {'book': 8720.59, 'rejected': 277.73}},
        }
    },
    'wj10': {
        'ad_cost': 1815,
        'ad_cost_cny': 0,
        'active_campaigns': 20,
        'platforms': {
            'RW': {'thgoodsandguard': {'book': 1463.91, 'rejected': 367.84}},
            'LH': {'allurahub': {'book': 44.24, 'rejected': 0}},
            'CG': {'bloomroots': {'book': 1594.08, 'rejected': 5.75}},
        }
    },
}

def get_or_create_platform(platform_code):
    """获取或创建平台"""
    platform = db.query(AffiliatePlatform).filter(AffiliatePlatform.platform_name == platform_code).first()
    if not platform:
        # 平台URL映射
        platform_urls = {
            'RW': 'https://www.rewardoo.com/',
            'LH': 'https://www.linkhaitao.com/',
            'CG': 'https://app.collabglow.com/',
            'LB': 'https://www.linkbux.com/',
            'PM': 'https://app.partnermatic.com',
            'CF': 'https://www.creatorflare.com/',
            'BSH': 'https://www.brandsparkhub.com/',
        }
        platform = AffiliatePlatform(
            platform_name=platform_code,
            platform_code=platform_urls.get(platform_code, platform_code)
        )
        db.add(platform)
        db.commit()
        db.refresh(platform)
        print(f"  创建平台: {platform_code}")
    return platform


def get_or_create_account(user, platform, account_name):
    """获取或创建账号"""
    account = db.query(AffiliateAccount).filter(
        AffiliateAccount.user_id == user.id,
        AffiliateAccount.platform_id == platform.id,
        AffiliateAccount.account_name == account_name
    ).first()
    
    if not account:
        account = AffiliateAccount(
            user_id=user.id,
            platform_id=platform.id,
            account_name=account_name,
            is_active=True
        )
        db.add(account)
        db.commit()
        db.refresh(account)
        print(f"    创建账号: {account_name}")
    return account


def import_transactions(user, account, platform_name, book_commission, rejected_commission):
    """导入交易数据"""
    # 1月份的日期范围
    jan_start = datetime(2026, 1, 1, 0, 0, 0)
    jan_end = datetime(2026, 1, 31, 23, 59, 59)
    
    # 检查是否已导入过
    existing = db.query(AffiliateTransaction).filter(
        AffiliateTransaction.affiliate_account_id == account.id,
        AffiliateTransaction.transaction_time >= jan_start,
        AffiliateTransaction.transaction_time <= jan_end
    ).first()
    
    if existing:
        print(f"      账号 {account.account_name} 1月份数据已存在，跳过")
        return
    
    # 创建汇总交易记录（账面佣金 - 拒付佣金 = 有效佣金）
    valid_commission = Decimal(str(book_commission)) - Decimal(str(rejected_commission))
    
    if valid_commission > 0:
        # 创建有效佣金交易
        tx_approved = AffiliateTransaction(
            platform=platform_name,
            merchant='January Import',
            transaction_id=f"JAN2026-{user.username}-{account.account_name}-APPROVED",
            transaction_time=datetime(2026, 1, 15, 12, 0, 0),  # 用1月15日作为代表日期
            order_amount=valid_commission * 10,  # 假设GMV是佣金的10倍
            commission_amount=valid_commission,
            currency='USD',
            status='approved',
            raw_status='approved',
            affiliate_account_id=account.id,
            user_id=user.id
        )
        db.add(tx_approved)
    
    if rejected_commission > 0:
        # 创建拒付佣金交易
        tx_rejected = AffiliateTransaction(
            platform=platform_name,
            merchant='January Import',
            transaction_id=f"JAN2026-{user.username}-{account.account_name}-REJECTED",
            transaction_time=datetime(2026, 1, 15, 12, 0, 0),
            order_amount=Decimal(str(rejected_commission)) * 10,
            commission_amount=Decimal(str(rejected_commission)),
            currency='USD',
            status='rejected',
            raw_status='rejected',
            affiliate_account_id=account.id,
            user_id=user.id
        )
        db.add(tx_rejected)
    
    db.commit()
    print(f"      导入交易: 有效={valid_commission:.2f}, 拒付={rejected_commission:.2f}")


def main():
    print("=" * 60)
    print("导入2026年1月份数据")
    print("=" * 60)
    
    for username, data in JAN_DATA.items():
        print(f"\n【{username}】")
        
        # 获取用户
        user = db.query(User).filter(User.username == username).first()
        if not user:
            print(f"  用户不存在，跳过")
            continue
        
        # 处理每个平台
        for platform_code, accounts in data['platforms'].items():
            print(f"  平台: {platform_code}")
            platform = get_or_create_platform(platform_code)
            
            for account_name, commissions in accounts.items():
                print(f"    账号: {account_name}")
                account = get_or_create_account(user, platform, account_name)
                
                book = commissions['book']
                rejected = commissions['rejected']
                import_transactions(user, account, platform_code, book, rejected)
    
    print("\n" + "=" * 60)
    print("导入完成！")
    print("=" * 60)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f"错误: {e}")
        db.rollback()
    finally:
        db.close()

