"""
报表API
- 财务报表
- 本月报表
- 本季度报表
- 本年度报表
"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, and_, extract
from typing import Optional
from datetime import date, datetime
from decimal import Decimal

from app.database import get_db
from app.models.user import User
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.affiliate_transaction import AffiliateTransaction
from app.models.google_ads_api_data import GoogleAdsApiData, GoogleMccAccount
from app.api.auth import get_current_user

router = APIRouter(prefix="/api/reports", tags=["reports"])

# 平台代码映射
PLATFORM_SHORT = {
    'collabglow': 'CG',
    'brandsparkhub': 'BSH',
    'linkbux': 'LB',
    'partnermatic': 'PM',
    'linkhaitao': 'LH',
    'rewardoo': 'RW',
    'creatorflare': 'CF',
}

# wj07的RW账号合并映射（3个账号合并为wenjun）
WJ07_RW_MERGE = ['wenjun', 'thegoodsandguard', 'vivaluxelife']


def get_platform_short_code(platform_code: str) -> str:
    """获取平台简短代码"""
    if not platform_code:
        return "未知"
    for key, short in PLATFORM_SHORT.items():
        if key in platform_code.lower():
            return short
    return platform_code


def get_date_range(period: str, year: int = None, month: int = None, quarter: int = None):
    """根据周期获取日期范围"""
    today = date.today()
    
    if period == "month":
        # 本月
        if year and month:
            start = date(year, month, 1)
            if month == 12:
                end = date(year + 1, 1, 1)
            else:
                end = date(year, month + 1, 1)
            end = date(end.year, end.month, 1) - timedelta(days=1) if end.day == 1 else end
            # 简化：直接用下月1日减1天
            import calendar
            last_day = calendar.monthrange(year, month)[1]
            end = date(year, month, last_day)
        else:
            start = date(today.year, today.month, 1)
            import calendar
            last_day = calendar.monthrange(today.year, today.month)[1]
            end = date(today.year, today.month, last_day)
    elif period == "quarter":
        # 本季度
        if year and quarter:
            start_month = (quarter - 1) * 3 + 1
            end_month = quarter * 3
            start = date(year, start_month, 1)
            import calendar
            last_day = calendar.monthrange(year, end_month)[1]
            end = date(year, end_month, last_day)
        else:
            current_quarter = (today.month - 1) // 3 + 1
            start_month = (current_quarter - 1) * 3 + 1
            end_month = current_quarter * 3
            start = date(today.year, start_month, 1)
            import calendar
            last_day = calendar.monthrange(today.year, end_month)[1]
            end = date(today.year, end_month, last_day)
    elif period == "year":
        # 本年度
        if year:
            start = date(year, 1, 1)
            end = date(year, 12, 31)
        else:
            start = date(today.year, 1, 1)
            end = date(today.year, 12, 31)
    else:
        # 默认本月
        start = date(today.year, today.month, 1)
        import calendar
        last_day = calendar.monthrange(today.year, today.month)[1]
        end = date(today.year, today.month, last_day)
    
    return start, end


@router.get("/financial")
async def get_financial_report(
    year: int = Query(..., description="年份"),
    month: int = Query(..., description="月份"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    财务报表
    按员工 -> 平台 -> 账号 展示
    """
    import calendar
    start_date = date(year, month, 1)
    last_day = calendar.monthrange(year, month)[1]
    end_date = date(year, month, last_day)
    
    # 获取所有员工
    employees = db.query(User).filter(User.role == 'employee').order_by(User.username).all()
    
    result = []
    total_ad_cost = Decimal('0')
    total_book_commission = Decimal('0')
    total_rejected_commission = Decimal('0')
    
    for emp in employees:
        emp_display_name = emp.display_name or emp.username
        
        # 1. 获取该员工的广告费（从google_ads_api_data）
        emp_ad_cost = db.query(func.sum(GoogleAdsApiData.cost)).filter(
            GoogleAdsApiData.user_id == emp.id,
            GoogleAdsApiData.date >= start_date,
            GoogleAdsApiData.date <= end_date
        ).scalar() or Decimal('0')
        
        # 货币转换（如果有CNY的MCC）
        mcc_accounts = db.query(GoogleMccAccount).filter(GoogleMccAccount.user_id == emp.id).all()
        cny_mcc_ids = [m.id for m in mcc_accounts if m.currency == 'CNY']
        
        if cny_mcc_ids:
            # 单独计算CNY的费用并转换
            cny_cost = db.query(func.sum(GoogleAdsApiData.cost)).filter(
                GoogleAdsApiData.user_id == emp.id,
                GoogleAdsApiData.mcc_id.in_(cny_mcc_ids),
                GoogleAdsApiData.date >= start_date,
                GoogleAdsApiData.date <= end_date
            ).scalar() or Decimal('0')
            
            usd_cost = db.query(func.sum(GoogleAdsApiData.cost)).filter(
                GoogleAdsApiData.user_id == emp.id,
                GoogleAdsApiData.mcc_id.notin_(cny_mcc_ids),
                GoogleAdsApiData.date >= start_date,
                GoogleAdsApiData.date <= end_date
            ).scalar() or Decimal('0')
            
            emp_ad_cost = Decimal(str(usd_cost)) + Decimal(str(cny_cost)) / Decimal('7.2')
        
        emp_ad_cost = Decimal(str(emp_ad_cost))
        total_ad_cost += emp_ad_cost
        
        # 2. 获取该员工的平台账号数据
        accounts = db.query(AffiliateAccount).join(AffiliatePlatform).filter(
            AffiliateAccount.user_id == emp.id,
            AffiliateAccount.is_active == True
        ).all()
        
        # 按平台分组
        platform_data = {}
        for acc in accounts:
            platform_code = get_platform_short_code(acc.platform.platform_code) if acc.platform else "未知"
            
            # wj07的RW账号合并处理
            account_name = acc.account_name
            if emp.username == 'wj07' and platform_code == 'RW':
                # 合并为wenjun
                account_name = 'wenjun'
                if platform_code in platform_data and account_name in [a['account_name'] for a in platform_data[platform_code]]:
                    # 已经添加过了，跳过但要累加数据
                    continue
            
            # 账面佣金（所有状态）
            book_commission = db.query(func.sum(AffiliateTransaction.commission_amount)).filter(
                AffiliateTransaction.affiliate_account_id == acc.id,
                AffiliateTransaction.transaction_time >= datetime.combine(start_date, datetime.min.time()),
                AffiliateTransaction.transaction_time <= datetime.combine(end_date, datetime.max.time())
            ).scalar() or Decimal('0')
            
            # 失效佣金（rejected状态）
            rejected_commission = db.query(func.sum(AffiliateTransaction.commission_amount)).filter(
                AffiliateTransaction.affiliate_account_id == acc.id,
                AffiliateTransaction.status == 'rejected',
                AffiliateTransaction.transaction_time >= datetime.combine(start_date, datetime.min.time()),
                AffiliateTransaction.transaction_time <= datetime.combine(end_date, datetime.max.time())
            ).scalar() or Decimal('0')
            
            book_commission = Decimal(str(book_commission))
            rejected_commission = Decimal(str(rejected_commission))
            
            if platform_code not in platform_data:
                platform_data[platform_code] = []
            
            # 检查是否需要合并（wj07的RW账号）
            if emp.username == 'wj07' and platform_code == 'RW':
                # 查找已存在的wenjun记录
                existing = None
                for item in platform_data[platform_code]:
                    if item['account_name'] == 'wenjun':
                        existing = item
                        break
                
                if existing:
                    existing['book_commission'] = Decimal(str(existing['book_commission'])) + book_commission
                    existing['rejected_commission'] = Decimal(str(existing['rejected_commission'])) + rejected_commission
                else:
                    platform_data[platform_code].append({
                        'account_name': 'wenjun',
                        'book_commission': float(book_commission),
                        'rejected_commission': float(rejected_commission)
                    })
            else:
                platform_data[platform_code].append({
                    'account_name': acc.account_name,
                    'book_commission': float(book_commission),
                    'rejected_commission': float(rejected_commission)
                })
        
        # 如果是wj07，需要额外处理：合并3个RW账号的佣金
        if emp.username == 'wj07' and 'RW' in platform_data:
            # 获取所有3个RW账号的ID
            rw_account_ids = [acc.id for acc in accounts if get_platform_short_code(acc.platform.platform_code) == 'RW']
            
            if rw_account_ids:
                # 重新计算合并后的佣金
                total_book = db.query(func.sum(AffiliateTransaction.commission_amount)).filter(
                    AffiliateTransaction.affiliate_account_id.in_(rw_account_ids),
                    AffiliateTransaction.transaction_time >= datetime.combine(start_date, datetime.min.time()),
                    AffiliateTransaction.transaction_time <= datetime.combine(end_date, datetime.max.time())
                ).scalar() or Decimal('0')
                
                total_rejected = db.query(func.sum(AffiliateTransaction.commission_amount)).filter(
                    AffiliateTransaction.affiliate_account_id.in_(rw_account_ids),
                    AffiliateTransaction.status == 'rejected',
                    AffiliateTransaction.transaction_time >= datetime.combine(start_date, datetime.min.time()),
                    AffiliateTransaction.transaction_time <= datetime.combine(end_date, datetime.max.time())
                ).scalar() or Decimal('0')
                
                platform_data['RW'] = [{
                    'account_name': 'wenjun',
                    'book_commission': float(total_book),
                    'rejected_commission': float(total_rejected)
                }]
        
        # 构建员工数据
        emp_accounts = []
        emp_book_commission = Decimal('0')
        emp_rejected_commission = Decimal('0')
        
        for platform_code, accounts_list in platform_data.items():
            for acc_data in accounts_list:
                emp_accounts.append({
                    'platform': platform_code,
                    'account_name': acc_data['account_name'],
                    'book_commission': acc_data['book_commission'],
                    'rejected_commission': acc_data['rejected_commission']
                })
                emp_book_commission += Decimal(str(acc_data['book_commission']))
                emp_rejected_commission += Decimal(str(acc_data['rejected_commission']))
        
        total_book_commission += emp_book_commission
        total_rejected_commission += emp_rejected_commission
        
        result.append({
            'employee': emp_display_name,
            'username': emp.username,
            'ad_cost': float(emp_ad_cost),
            'accounts': emp_accounts,
            'total_book_commission': float(emp_book_commission),
            'total_rejected_commission': float(emp_rejected_commission)
        })
    
    return {
        'year': year,
        'month': month,
        'data': result,
        'summary': {
            'total_ad_cost': float(total_ad_cost),
            'total_book_commission': float(total_book_commission),
            'total_rejected_commission': float(total_rejected_commission),
            'total_valid_commission': float(total_book_commission - total_rejected_commission)
        }
    }


@router.get("/monthly")
async def get_monthly_report(
    year: int = Query(None, description="年份"),
    month: int = Query(None, description="月份"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    本月报表
    按员工汇总
    """
    import calendar
    today = date.today()
    year = year or today.year
    month = month or today.month
    
    start_date = date(year, month, 1)
    last_day = calendar.monthrange(year, month)[1]
    end_date = date(year, month, last_day)
    
    return await _get_summary_report(db, start_date, end_date, f"{year}年{month}月")


@router.get("/quarterly")
async def get_quarterly_report(
    year: int = Query(None, description="年份"),
    quarter: int = Query(None, description="季度 (1-4)"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    本季度报表
    按员工汇总
    """
    import calendar
    today = date.today()
    year = year or today.year
    quarter = quarter or ((today.month - 1) // 3 + 1)
    
    start_month = (quarter - 1) * 3 + 1
    end_month = quarter * 3
    
    start_date = date(year, start_month, 1)
    last_day = calendar.monthrange(year, end_month)[1]
    end_date = date(year, end_month, last_day)
    
    return await _get_summary_report(db, start_date, end_date, f"{year}年Q{quarter}")


@router.get("/yearly")
async def get_yearly_report(
    year: int = Query(None, description="年份"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    本年度报表
    按员工汇总
    """
    today = date.today()
    year = year or today.year
    
    start_date = date(year, 1, 1)
    end_date = date(year, 12, 31)
    
    return await _get_summary_report(db, start_date, end_date, f"{year}年")


async def _get_summary_report(db: Session, start_date: date, end_date: date, period_name: str):
    """
    生成汇总报表
    """
    employees = db.query(User).filter(User.role == 'employee').order_by(User.username).all()
    
    result = []
    total_ad_cost = Decimal('0')
    total_book_commission = Decimal('0')
    total_rejected_commission = Decimal('0')
    total_orders = 0
    total_active_campaigns = 0
    
    for emp in employees:
        emp_display_name = emp.display_name or emp.username
        
        # 1. 广告费
        emp_ad_cost = db.query(func.sum(GoogleAdsApiData.cost)).filter(
            GoogleAdsApiData.user_id == emp.id,
            GoogleAdsApiData.date >= start_date,
            GoogleAdsApiData.date <= end_date
        ).scalar() or Decimal('0')
        
        # 货币转换
        mcc_accounts = db.query(GoogleMccAccount).filter(GoogleMccAccount.user_id == emp.id).all()
        cny_mcc_ids = [m.id for m in mcc_accounts if m.currency == 'CNY']
        
        if cny_mcc_ids:
            cny_cost = db.query(func.sum(GoogleAdsApiData.cost)).filter(
                GoogleAdsApiData.user_id == emp.id,
                GoogleAdsApiData.mcc_id.in_(cny_mcc_ids),
                GoogleAdsApiData.date >= start_date,
                GoogleAdsApiData.date <= end_date
            ).scalar() or Decimal('0')
            
            usd_cost = db.query(func.sum(GoogleAdsApiData.cost)).filter(
                GoogleAdsApiData.user_id == emp.id,
                GoogleAdsApiData.mcc_id.notin_(cny_mcc_ids),
                GoogleAdsApiData.date >= start_date,
                GoogleAdsApiData.date <= end_date
            ).scalar() or Decimal('0')
            
            emp_ad_cost = Decimal(str(usd_cost)) + Decimal(str(cny_cost)) / Decimal('7.2')
        
        emp_ad_cost = Decimal(str(emp_ad_cost))
        total_ad_cost += emp_ad_cost
        
        # 2. 账面佣金（所有状态）
        emp_book_commission = db.query(func.sum(AffiliateTransaction.commission_amount)).filter(
            AffiliateTransaction.user_id == emp.id,
            AffiliateTransaction.transaction_time >= datetime.combine(start_date, datetime.min.time()),
            AffiliateTransaction.transaction_time <= datetime.combine(end_date, datetime.max.time())
        ).scalar() or Decimal('0')
        emp_book_commission = Decimal(str(emp_book_commission))
        total_book_commission += emp_book_commission
        
        # 3. 失效佣金（rejected状态）
        emp_rejected_commission = db.query(func.sum(AffiliateTransaction.commission_amount)).filter(
            AffiliateTransaction.user_id == emp.id,
            AffiliateTransaction.status == 'rejected',
            AffiliateTransaction.transaction_time >= datetime.combine(start_date, datetime.min.time()),
            AffiliateTransaction.transaction_time <= datetime.combine(end_date, datetime.max.time())
        ).scalar() or Decimal('0')
        emp_rejected_commission = Decimal(str(emp_rejected_commission))
        total_rejected_commission += emp_rejected_commission
        
        # 4. 订单数
        emp_orders = db.query(func.count(AffiliateTransaction.id)).filter(
            AffiliateTransaction.user_id == emp.id,
            AffiliateTransaction.transaction_time >= datetime.combine(start_date, datetime.min.time()),
            AffiliateTransaction.transaction_time <= datetime.combine(end_date, datetime.max.time())
        ).scalar() or 0
        total_orders += emp_orders
        
        # 5. 在跑广告量（已启用的广告系列数）
        # 取最新一天的数据
        emp_active_campaigns = db.query(func.count(func.distinct(GoogleAdsApiData.campaign_id))).filter(
            GoogleAdsApiData.user_id == emp.id,
            GoogleAdsApiData.status == '已启用',
            GoogleAdsApiData.date == end_date
        ).scalar() or 0
        
        # 如果最后一天没有数据，往前找
        if emp_active_campaigns == 0:
            latest_date = db.query(func.max(GoogleAdsApiData.date)).filter(
                GoogleAdsApiData.user_id == emp.id,
                GoogleAdsApiData.date <= end_date
            ).scalar()
            
            if latest_date:
                emp_active_campaigns = db.query(func.count(func.distinct(GoogleAdsApiData.campaign_id))).filter(
                    GoogleAdsApiData.user_id == emp.id,
                    GoogleAdsApiData.status == '已启用',
                    GoogleAdsApiData.date == latest_date
                ).scalar() or 0
        
        total_active_campaigns += emp_active_campaigns
        
        # 有效佣金
        emp_valid_commission = emp_book_commission - emp_rejected_commission
        
        result.append({
            'employee': emp_display_name,
            'username': emp.username,
            'ad_cost': float(emp_ad_cost),
            'book_commission': float(emp_book_commission),
            'rejected_commission': float(emp_rejected_commission),
            'valid_commission': float(emp_valid_commission),
            'orders': emp_orders,
            'active_campaigns': emp_active_campaigns
        })
    
    return {
        'period': period_name,
        'start_date': start_date.isoformat(),
        'end_date': end_date.isoformat(),
        'data': result,
        'summary': {
            'total_ad_cost': float(total_ad_cost),
            'total_book_commission': float(total_book_commission),
            'total_rejected_commission': float(total_rejected_commission),
            'total_valid_commission': float(total_book_commission - total_rejected_commission),
            'total_orders': total_orders,
            'total_active_campaigns': total_active_campaigns
        }
    }

