"""
数据总览API

- 经理：全站概览、员工列表等
- 员工：个人概览（Top/Bottom 广告系列 + 趋势）
"""
from typing import List, Optional, Dict, Any
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func, and_
from datetime import date, timedelta, datetime

from app.database import get_db
from app.middleware.auth import get_current_manager, get_current_user
from app.models.user import User, UserRole
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.analysis_result import AnalysisResult
from app.models.google_ads_api_data import GoogleAdsApiData, GoogleMccAccount
from app.models.affiliate_transaction import AffiliateTransaction
from app.api.google_ads_aggregate import convert_to_usd
import re
import math

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


def safe_number(val, default=0):
    """安全地将各种格式转为数值，防止 platform-summary 500 错误"""
    if val is None:
        return default
    if isinstance(val, (int, float)):
        return default if (isinstance(val, float) and math.isnan(val)) else val
    if isinstance(val, str):
        s = val.strip()
        if not s or s in ("N/A", "null", "None", "-", "--", "n/a"):
            return default
        s = s.replace(",", "")
        if s.startswith("(") and s.endswith(")"):
            s = "-" + s[1:-1]
        try:
            return float(s)
        except (ValueError, TypeError):
            return default
    return default

# 注意：/platform-summary 与 /account-details 仍使用旧的 AnalysisResult 历史分析数据，
# 目前未被“数据总览”页面使用。若后续需要，也应整体迁移到实时来源。


@router.get("/overview")
async def get_overview(
    current_user: User = Depends(get_current_manager),
    db: Session = Depends(get_db)
):
    """经理总览：全部改为实时来源（Google Ads 同步 + 联盟交易）"""
    today = date.today()
    start_7d = today - timedelta(days=6)
    # 本月起始日期
    start_month = today.replace(day=1)

    total_employees = db.query(User).filter(User.role == UserRole.EMPLOYEE).count()
    total_mcc_accounts = db.query(GoogleMccAccount).count()

    campaigns_7d = db.query(func.count(func.distinct(GoogleAdsApiData.campaign_id))).filter(
        GoogleAdsApiData.date >= start_7d,
        GoogleAdsApiData.date <= today,
    ).scalar() or 0

    # 获取所有MCC的货币映射
    all_mccs = db.query(GoogleMccAccount).all()
    mcc_currency_map = {mcc.id: getattr(mcc, 'currency', 'USD') or 'USD' for mcc in all_mccs}

    # 按MCC分组汇总费用（近7天），再做货币转换
    cost_by_mcc_7d = db.query(
        GoogleAdsApiData.mcc_id,
        func.sum(GoogleAdsApiData.cost).label("cost"),
    ).filter(
        GoogleAdsApiData.date >= start_7d,
        GoogleAdsApiData.date <= today,
    ).group_by(GoogleAdsApiData.mcc_id).all()
    cost_7d = sum(
        convert_to_usd(float(r.cost or 0.0), mcc_currency_map.get(r.mcc_id, 'USD'))
        for r in cost_by_mcc_7d
    )

    # 按MCC分组汇总费用（本月），再做货币转换
    cost_by_mcc_month = db.query(
        GoogleAdsApiData.mcc_id,
        func.sum(GoogleAdsApiData.cost).label("cost"),
    ).filter(
        GoogleAdsApiData.date >= start_month,
        GoogleAdsApiData.date <= today,
    ).group_by(GoogleAdsApiData.mcc_id).all()
    cost_month = sum(
        convert_to_usd(float(r.cost or 0.0), mcc_currency_map.get(r.mcc_id, 'USD'))
        for r in cost_by_mcc_month
    )

    # 佣金：按交易时间窗口（所有状态计入总佣金）
    # 排除已删除/停用账号的交易
    start_dt_7d = datetime.combine(start_7d, datetime.min.time())
    end_dt = datetime.combine(today, datetime.max.time())
    commission_7d = db.query(func.sum(AffiliateTransaction.commission_amount)).outerjoin(
        AffiliateAccount,
        AffiliateTransaction.affiliate_account_id == AffiliateAccount.id
    ).filter(
        AffiliateTransaction.transaction_time >= start_dt_7d,
        AffiliateTransaction.transaction_time <= end_dt,
        # 排除已停用账号的交易（账号不存在或已激活）
        (AffiliateAccount.id.is_(None)) | (AffiliateAccount.is_active == True)
    ).scalar() or 0.0

    # 本月佣金和订单
    start_dt_month = datetime.combine(start_month, datetime.min.time())
    commission_orders_month = db.query(
        func.sum(AffiliateTransaction.commission_amount).label("commission"),
        func.count(AffiliateTransaction.id).label("orders")
    ).outerjoin(
        AffiliateAccount,
        AffiliateTransaction.affiliate_account_id == AffiliateAccount.id
    ).filter(
        AffiliateTransaction.transaction_time >= start_dt_month,
        AffiliateTransaction.transaction_time <= end_dt,
        (AffiliateAccount.id.is_(None)) | (AffiliateAccount.is_active == True)
    ).first()
    commission_month = float(commission_orders_month.commission or 0.0) if commission_orders_month else 0.0
    orders_month = int(commission_orders_month.orders or 0) if commission_orders_month else 0

    # 本月ROI计算
    roi_month = ((commission_month - cost_month) / cost_month * 100) if cost_month > 0 else 0.0

    # 活跃员工：近7天有Google Ads数据或有交易数据的员工
    active_ads_users = db.query(func.distinct(GoogleAdsApiData.user_id)).filter(
        GoogleAdsApiData.date >= start_7d,
        GoogleAdsApiData.date <= today,
    ).all()
    active_tx_users = db.query(func.distinct(AffiliateTransaction.user_id)).filter(
        AffiliateTransaction.user_id.isnot(None),
        AffiliateTransaction.transaction_time >= start_dt_7d,
        AffiliateTransaction.transaction_time <= end_dt,
    ).all()
    active_user_ids = {r[0] for r in active_ads_users if r and r[0]} | {r[0] for r in active_tx_users if r and r[0]}

    last_sync_at = db.query(func.max(GoogleAdsApiData.last_sync_at)).scalar()

    return {
        "total_employees": int(total_employees or 0),
        "active_employees_7d": int(len(active_user_ids)),
        "total_mcc_accounts": int(total_mcc_accounts or 0),
        "campaigns_7d": int(campaigns_7d or 0),
        "cost_7d": float(cost_7d or 0.0),
        "commission_7d": float(commission_7d or 0.0),
        "cost_month": float(cost_month or 0.0),
        "commission_month": float(commission_month or 0.0),
        "orders_month": orders_month,
        "roi_month": round(roi_month, 2),
        "last_google_sync_at": last_sync_at.isoformat() if last_sync_at else None,
    }


@router.get("/trend")
async def get_manager_trend(
    current_user: User = Depends(get_current_manager),
    db: Session = Depends(get_db)
):
    """经理视角的费用佣金每日走向（本月）"""
    today = date.today()
    start_month = today.replace(day=1)
    
    # 获取所有MCC的货币映射
    all_mccs = db.query(GoogleMccAccount).all()
    mcc_currency_map = {mcc.id: getattr(mcc, 'currency', 'USD') or 'USD' for mcc in all_mccs}
    
    # 按日期和MCC分组获取费用
    cost_by_date_mcc = db.query(
        GoogleAdsApiData.date,
        GoogleAdsApiData.mcc_id,
        func.sum(GoogleAdsApiData.cost).label("cost"),
    ).filter(
        GoogleAdsApiData.date >= start_month,
        GoogleAdsApiData.date <= today,
    ).group_by(GoogleAdsApiData.date, GoogleAdsApiData.mcc_id).all()
    
    # 按日期汇总费用（转换货币）
    cost_by_date: Dict[date, float] = {}
    for r in cost_by_date_mcc:
        d = r.date
        cost_usd = convert_to_usd(float(r.cost or 0.0), mcc_currency_map.get(r.mcc_id, 'USD'))
        cost_by_date[d] = cost_by_date.get(d, 0.0) + cost_usd
    
    # 按日期获取佣金
    start_dt = datetime.combine(start_month, datetime.min.time())
    end_dt = datetime.combine(today, datetime.max.time())
    
    commission_by_date_rows = db.query(
        func.date(AffiliateTransaction.transaction_time).label("d"),
        func.sum(AffiliateTransaction.commission_amount).label("commission"),
    ).outerjoin(
        AffiliateAccount,
        AffiliateTransaction.affiliate_account_id == AffiliateAccount.id
    ).filter(
        AffiliateTransaction.transaction_time >= start_dt,
        AffiliateTransaction.transaction_time <= end_dt,
        (AffiliateAccount.id.is_(None)) | (AffiliateAccount.is_active == True)
    ).group_by(func.date(AffiliateTransaction.transaction_time)).all()
    
    commission_by_date: Dict[date, float] = {}
    for r in commission_by_date_rows:
        d = r.d if isinstance(r.d, date) else datetime.strptime(str(r.d), "%Y-%m-%d").date()
        commission_by_date[d] = float(r.commission or 0.0)
    
    # 合并所有日期
    all_dates = sorted(set(cost_by_date.keys()) | set(commission_by_date.keys()))
    
    trend = []
    for d in all_dates:
        trend.append({
            "date": d.strftime("%m-%d"),
            "cost": round(cost_by_date.get(d, 0.0), 2),
            "commission": round(commission_by_date.get(d, 0.0), 2),
        })
    
    return {"trend": trend}


@router.get("/employees")
async def get_employees_data(
    current_user: User = Depends(get_current_manager),
    db: Session = Depends(get_db)
):
    """经理员工列表：实时来源（Google Ads 同步 + 联盟交易）"""
    today = date.today()
    start_7d = today - timedelta(days=6)
    start_month = today.replace(day=1)
    start_dt_7d = datetime.combine(start_7d, datetime.min.time())
    start_dt_month = datetime.combine(start_month, datetime.min.time())
    end_dt = datetime.combine(today, datetime.max.time())

    employees = db.query(User).filter(User.role == UserRole.EMPLOYEE).all()
    employee_ids = [e.id for e in employees]

    # MCC数
    mcc_rows = db.query(
        GoogleMccAccount.user_id,
        func.count(GoogleMccAccount.id).label("mcc_count"),
    ).filter(
        GoogleMccAccount.user_id.in_(employee_ids)
    ).group_by(GoogleMccAccount.user_id).all()
    mcc_map = {r.user_id: int(r.mcc_count or 0) for r in mcc_rows}

    # MCC货币映射
    all_mccs_emp = db.query(GoogleMccAccount).all()
    mcc_currency_map_emp = {mcc.id: getattr(mcc, 'currency', 'USD') or 'USD' for mcc in all_mccs_emp}

    # Google Ads 聚合（近7天），按user_id+mcc_id分组以便做货币转换
    ads_rows_7d = db.query(
        GoogleAdsApiData.user_id,
        GoogleAdsApiData.mcc_id,
        func.count(func.distinct(GoogleAdsApiData.campaign_id)).label("campaigns_7d"),
        func.sum(GoogleAdsApiData.cost).label("cost_7d"),
        func.max(GoogleAdsApiData.last_sync_at).label("last_sync_at"),
    ).filter(
        GoogleAdsApiData.user_id.in_(employee_ids),
        GoogleAdsApiData.date >= start_7d,
        GoogleAdsApiData.date <= today,
    ).group_by(GoogleAdsApiData.user_id, GoogleAdsApiData.mcc_id).all()
    
    ads_map: Dict[int, dict] = {}
    for r in ads_rows_7d:
        uid = r.user_id
        currency = mcc_currency_map_emp.get(r.mcc_id, 'USD')
        cost_usd = convert_to_usd(float(r.cost_7d or 0.0), currency)
        if uid not in ads_map:
            ads_map[uid] = {"campaigns_7d": 0, "cost_7d": 0.0, "last_sync_at": None}
        ads_map[uid]["campaigns_7d"] += int(r.campaigns_7d or 0)
        ads_map[uid]["cost_7d"] += cost_usd
        if r.last_sync_at:
            existing = ads_map[uid]["last_sync_at"]
            new_ts = r.last_sync_at.isoformat()
            if existing is None or new_ts > existing:
                ads_map[uid]["last_sync_at"] = new_ts

    # Google Ads 聚合（本月），按user_id+mcc_id分组
    ads_rows_month = db.query(
        GoogleAdsApiData.user_id,
        GoogleAdsApiData.mcc_id,
        func.sum(GoogleAdsApiData.cost).label("cost_month"),
    ).filter(
        GoogleAdsApiData.user_id.in_(employee_ids),
        GoogleAdsApiData.date >= start_month,
        GoogleAdsApiData.date <= today,
    ).group_by(GoogleAdsApiData.user_id, GoogleAdsApiData.mcc_id).all()
    
    ads_map_month: Dict[int, float] = {}
    for r in ads_rows_month:
        uid = r.user_id
        currency = mcc_currency_map_emp.get(r.mcc_id, 'USD')
        cost_usd = convert_to_usd(float(r.cost_month or 0.0), currency)
        ads_map_month[uid] = ads_map_month.get(uid, 0.0) + cost_usd

    # 交易聚合（近7天）- 排除已停用账号
    tx_rows_7d = db.query(
        AffiliateTransaction.user_id,
        func.sum(AffiliateTransaction.commission_amount).label("commission_7d"),
        func.count(AffiliateTransaction.id).label("orders_7d"),
    ).outerjoin(
        AffiliateAccount,
        AffiliateTransaction.affiliate_account_id == AffiliateAccount.id
    ).filter(
        AffiliateTransaction.user_id.in_(employee_ids),
        AffiliateTransaction.transaction_time >= start_dt_7d,
        AffiliateTransaction.transaction_time <= end_dt,
        (AffiliateAccount.id.is_(None)) | (AffiliateAccount.is_active == True)
    ).group_by(AffiliateTransaction.user_id).all()
    tx_map_7d = {
        r.user_id: {
            "commission_7d": float(r.commission_7d or 0.0),
            "orders_7d": int(r.orders_7d or 0),
        }
        for r in tx_rows_7d
    }

    # 交易聚合（本月）- 排除已停用账号
    tx_rows_month = db.query(
        AffiliateTransaction.user_id,
        func.sum(AffiliateTransaction.commission_amount).label("commission_month"),
        func.count(AffiliateTransaction.id).label("orders_month"),
    ).outerjoin(
        AffiliateAccount,
        AffiliateTransaction.affiliate_account_id == AffiliateAccount.id
    ).filter(
        AffiliateTransaction.user_id.in_(employee_ids),
        AffiliateTransaction.transaction_time >= start_dt_month,
        AffiliateTransaction.transaction_time <= end_dt,
        (AffiliateAccount.id.is_(None)) | (AffiliateAccount.is_active == True)
    ).group_by(AffiliateTransaction.user_id).all()
    tx_map_month = {
        r.user_id: {
            "commission_month": float(r.commission_month or 0.0),
            "orders_month": int(r.orders_month or 0),
        }
        for r in tx_rows_month
    }

    result = []
    for e in employees:
        a = ads_map.get(e.id, {})
        t7d = tx_map_7d.get(e.id, {})
        tm = tx_map_month.get(e.id, {})
        result.append({
            "employee_id": e.employee_id,
            "username": e.username,
            "mcc_count": mcc_map.get(e.id, 0),
            "campaigns_7d": a.get("campaigns_7d", 0),
            "cost_7d": a.get("cost_7d", 0.0),
            "commission_7d": t7d.get("commission_7d", 0.0),
            "orders_7d": t7d.get("orders_7d", 0),
            "cost_month": ads_map_month.get(e.id, 0.0),
            "commission_month": tm.get("commission_month", 0.0),
            "orders_month": tm.get("orders_month", 0),
            "last_google_sync_at": a.get("last_sync_at"),
        })

    # 默认按 cost_month 降序
    result.sort(key=lambda x: float(x.get("cost_month") or 0.0), reverse=True)
    return result


def _calc_range_dates(range_key: str) -> tuple[date, date]:
    """支持：7d / 15d / month"""
    today = date.today()
    rk = (range_key or "7d").strip().lower()
    if rk in ["7d", "7", "past7", "过去7天", "过去七天"]:
        return today - timedelta(days=6), today
    if rk in ["15d", "15", "past15", "过去15天"]:
        return today - timedelta(days=14), today
    if rk in ["month", "本月"]:
        start = today.replace(day=1)
        return start, today
    # 默认 7d
    return today - timedelta(days=6), today


def _ai_commentary(c: dict) -> str:
    """
    规则版“AI点评”（不依赖外部Key）。
    后续如需接大模型，可在这里替换为真实AI调用。
    """
    name = c.get("campaign_name", "-")
    roi = c.get("roi")
    orders = c.get("orders", 0) or 0
    cost = c.get("cost", 0) or 0
    comm = c.get("commission", 0) or 0
    cpc = c.get("cpc")

    parts = [f"【{name}】"]
    if cost <= 0:
        parts.append("花费为0，可能未投放或数据缺失，建议先确认投放状态与费用来源。")
        return "".join(parts)

    # ROI 评价
    if roi is None:
        parts.append("ROI无法计算（费用为0或数据缺失）。")
    elif roi >= 1.5:
        parts.append("ROI表现非常强，属于“健康”广告。")
    elif roi >= 1.0:
        parts.append("ROI达标，属于“观察”广告。")
    else:
        parts.append("ROI偏弱，属于“危险”广告。")

    # 订单/样本
    if orders >= 3:
        parts.append("订单样本充足，结论可信度较高。")
    elif orders >= 1:
        parts.append("已有出单，但样本偏少，建议继续观察并优化。")
    else:
        parts.append("当前无出单，建议排查关键词/素材/落地页，必要时降价或暂停。")

    # 成本/佣金
    parts.append(f"区间佣金{comm:.2f}、费用{cost:.2f}。")
    if cpc is not None:
        parts.append(f"平均CPC约{cpc:.2f}。")
    return "".join(parts)

def _infer_platform_code_from_campaign_name(campaign_name: str) -> Optional[str]:
    """支持：001-LB1-xxx / 001_LB1_xxx / 001-LB-xxx"""
    if not campaign_name:
        return None
    m = re.match(r"^\d+[_-]([A-Za-z]{2,3})\d*[_-]", campaign_name)
    return m.group(1).upper() if m else None


def _infer_merchant_id_from_campaign_name(campaign_name: str) -> Optional[str]:
    """商家ID：广告系列名最后一段纯数字"""
    if not campaign_name:
        return None
    parts = [p for p in re.split(r"[_-]", campaign_name) if p]
    if len(parts) < 2:
        return None
    last = parts[-1]
    return last if re.match(r"^\d+$", last) else None


@router.get("/employee-insights")
async def get_employee_insights(
    range: str = "7d",
    user_id: Optional[int] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    员工数据总览（员工看自己；经理可指定 user_id 看某员工）：
    - Top3 广告系列、Bottom3 广告系列（按 ROI 排序）
    - 佣金趋势（按日）
    - 费用趋势（按日）
    - “AI点评”（规则版）
    """
    target_user_id = current_user.id
    if user_id is not None:
        if current_user.role != UserRole.MANAGER:
            raise HTTPException(status_code=403, detail="Not enough permissions")
        target_user_id = int(user_id)

    start_d, end_d = _calc_range_dates(range)

    # 时间窗口
    start_dt = datetime.combine(start_d, datetime.min.time())
    end_dt = datetime.combine(end_d, datetime.max.time())

    # 1) 趋势：Google Ads 费用（按天），带货币转换
    cost_rows = db.query(
        GoogleAdsApiData.date.label("date"),
        GoogleAdsApiData.mcc_id,
        func.sum(GoogleAdsApiData.cost).label("cost"),
    ).filter(
        GoogleAdsApiData.user_id == target_user_id,
        GoogleAdsApiData.date >= start_d,
        GoogleAdsApiData.date <= end_d,
    ).group_by(GoogleAdsApiData.date, GoogleAdsApiData.mcc_id).all()
    # MCC货币映射
    user_mccs = db.query(GoogleMccAccount).filter(GoogleMccAccount.user_id == target_user_id).all()
    insight_currency_map = {mcc.id: getattr(mcc, 'currency', 'USD') or 'USD' for mcc in user_mccs}
    cost_map: Dict[str, float] = {}
    for r in cost_rows:
        ds = r.date.strftime("%Y-%m-%d")
        currency = insight_currency_map.get(r.mcc_id, 'USD')
        cost_usd = convert_to_usd(float(r.cost or 0.0), currency)
        cost_map[ds] = cost_map.get(ds, 0.0) + cost_usd

    # 2) 趋势：联盟佣金（所有状态计入总佣金）（按天）- 排除已停用账号
    comm_rows = db.query(
        func.date(AffiliateTransaction.transaction_time).label("d"),
        func.sum(AffiliateTransaction.commission_amount).label("commission"),
    ).outerjoin(
        AffiliateAccount,
        AffiliateTransaction.affiliate_account_id == AffiliateAccount.id
    ).filter(
        AffiliateTransaction.user_id == target_user_id,
        AffiliateTransaction.transaction_time >= start_dt,
        AffiliateTransaction.transaction_time <= end_dt,
        (AffiliateAccount.id.is_(None)) | (AffiliateAccount.is_active == True)
    ).group_by(func.date(AffiliateTransaction.transaction_time)).all()
    comm_map = {
        (r.d.strftime("%Y-%m-%d") if hasattr(r.d, "strftime") else str(r.d)): float(r.commission or 0.0)
        for r in comm_rows
    }

    # 生成完整日期序列
    trend = []
    d = start_d
    while d <= end_d:
        ds = d.strftime("%Y-%m-%d")
        trend.append({
            "date": ds,
            "commission": float(comm_map.get(ds, 0.0)),
            "cost": float(cost_map.get(ds, 0.0)),
        })
        d += timedelta(days=1)

    # 3) 预加载：用户的联盟账号映射 (platform_code, account_code)->affiliate_account_id
    account_rows = db.query(
        AffiliateAccount.id,
        AffiliateAccount.account_code,
        AffiliatePlatform.platform_code,
    ).join(
        AffiliatePlatform, AffiliatePlatform.id == AffiliateAccount.platform_id
    ).filter(
        AffiliateAccount.user_id == target_user_id,
        AffiliateAccount.is_active == True,
    ).all()
    acct_map = {}
    for r in account_rows:
        pcode = (r.platform_code or "").upper()
        acode = (r.account_code or "").strip()
        if pcode and acode:
            acct_map[(pcode, acode)] = int(r.id)

    # 4) 预加载：近区间内按 affiliate_account_id 聚合佣金/订单 - 排除已停用账号
    tx_by_acct = db.query(
        AffiliateTransaction.affiliate_account_id.label("aid"),
        func.sum(AffiliateTransaction.commission_amount).label("commission"),
        func.count(AffiliateTransaction.id).label("orders"),
    ).join(
        AffiliateAccount,
        AffiliateTransaction.affiliate_account_id == AffiliateAccount.id
    ).filter(
        AffiliateTransaction.user_id == target_user_id,
        AffiliateTransaction.affiliate_account_id.isnot(None),
        AffiliateTransaction.transaction_time >= start_dt,
        AffiliateTransaction.transaction_time <= end_dt,
        AffiliateAccount.is_active == True  # 只计入活跃账号
    ).group_by(AffiliateTransaction.affiliate_account_id).all()
    comm_by_aid = {int(r.aid): float(r.commission or 0.0) for r in tx_by_acct if r.aid is not None}
    orders_by_aid = {int(r.aid): int(r.orders or 0) for r in tx_by_acct if r.aid is not None}

    # 5) 广告系列聚合（按 campaign_id）：费用/点击/展示（实时），带货币转换
    camp_rows = db.query(
        GoogleAdsApiData.campaign_id.label("campaign_id"),
        GoogleAdsApiData.campaign_name.label("campaign_name"),
        GoogleAdsApiData.mcc_id.label("mcc_id"),
        func.sum(GoogleAdsApiData.cost).label("cost"),
        func.sum(GoogleAdsApiData.clicks).label("clicks"),
        func.sum(GoogleAdsApiData.impressions).label("impressions"),
    ).filter(
        GoogleAdsApiData.user_id == target_user_id,
        GoogleAdsApiData.date >= start_d,
        GoogleAdsApiData.date <= end_d,
    ).group_by(
        GoogleAdsApiData.campaign_id, GoogleAdsApiData.campaign_name, GoogleAdsApiData.mcc_id
    ).all()

    campaigns = []
    for r in camp_rows:
        raw_cost = float(r.cost or 0.0)
        currency = insight_currency_map.get(r.mcc_id, 'USD')
        cost = convert_to_usd(raw_cost, currency)
        clicks = float(r.clicks or 0.0)
        impressions = float(r.impressions or 0.0)
        platform_code = _infer_platform_code_from_campaign_name(r.campaign_name)
        merchant_id = _infer_merchant_id_from_campaign_name(r.campaign_name)

        affiliate_account_id = None
        if platform_code and merchant_id:
            affiliate_account_id = acct_map.get((platform_code.upper(), str(merchant_id).strip()))

        commission = float(comm_by_aid.get(int(affiliate_account_id), 0.0)) if affiliate_account_id else 0.0
        orders = int(orders_by_aid.get(int(affiliate_account_id), 0)) if affiliate_account_id else 0

        roi = ((commission - cost) / cost) if cost > 0 else None
        cpc = (cost / clicks) if clicks > 0 else None

        campaigns.append({
            "campaign_id": str(r.campaign_id),
            "campaign_name": r.campaign_name,
            "commission": commission,
            "cost": cost,
            "orders": orders,
            "clicks": clicks,
            "impressions": impressions,
            "roi": roi,
            "cpc": cpc,
        })

    # 排序取 Top/Bottom 3：优先按 ROI（费用>0），同 ROI 再按佣金
    valid = [c for c in campaigns if c.get("roi") is not None]
    valid_sorted = sorted(valid, key=lambda x: (x["roi"], x["commission"]), reverse=True)
    top3 = valid_sorted[:3]
    bottom3 = list(reversed(valid_sorted[-3:])) if len(valid_sorted) >= 3 else list(reversed(valid_sorted))

    for c in top3:
        c["ai_commentary"] = _ai_commentary(c)
    for c in bottom3:
        c["ai_commentary"] = _ai_commentary(c)

    total_cost = float(sum([t.get("cost", 0.0) for t in trend]) or 0.0)
    total_commission = float(sum([t.get("commission", 0.0) for t in trend]) or 0.0)
    total_roi = ((total_commission - total_cost) / total_cost) if total_cost > 0 else None

    return {
        "user_id": target_user_id,
        "range": range,
        "start_date": start_d.strftime("%Y-%m-%d"),
        "end_date": end_d.strftime("%Y-%m-%d"),
        "summary": {
            "total_commission": round(total_commission, 2),
            "total_cost": round(total_cost, 2),
            "roi": round(float(total_roi), 4) if total_roi is not None else None,
            "campaigns": len(campaigns),
        },
        "top3": top3,
        "bottom3": bottom3,
        "trend": trend,
    }


@router.get("/platform-summary")
async def get_platform_summary(
    current_user: User = Depends(get_current_manager),
    db: Session = Depends(get_db)
):
    """获取各联盟平台的数据汇总"""
    platforms = db.query(AffiliatePlatform).all()
    
    result = []
    for platform in platforms:
        # 获取该平台下的所有账号
        accounts = db.query(AffiliateAccount).filter(
            AffiliateAccount.platform_id == platform.id
        ).all()
        
        account_ids = [acc.id for acc in accounts]
        
        # 统计该平台的数据
        analyses = db.query(AnalysisResult).filter(
            AnalysisResult.affiliate_account_id.in_(account_ids)
        ).all()
        
        # 计算汇总数据
        total_clicks = 0
        total_orders = 0
        total_commission = 0
        epc_list = []
        roi_list = []
        
        for analysis in analyses:
            result_data = analysis.result_data
            if isinstance(result_data, dict) and "data" in result_data:
                for row in result_data["data"]:
                    total_clicks += safe_number(row.get("点击"))
                    total_orders += safe_number(row.get("订单数"))
                    total_commission += safe_number(row.get("保守佣金"))
                    epc_val = safe_number(row.get("保守EPC"))
                    if epc_val:
                        epc_list.append(epc_val)
                    roi_val = safe_number(row.get("保守ROI"))
                    if roi_val:
                        roi_list.append(roi_val)
        
        avg_epc = sum(epc_list) / len(epc_list) if epc_list else 0
        avg_roi = sum(roi_list) / len(roi_list) if roi_list else 0
        
        result.append({
            "platform_id": platform.id,
            "platform_name": platform.platform_name,
            "total_accounts": len(accounts),
            "active_accounts": len([acc for acc in accounts if acc.is_active]),
            "total_clicks": total_clicks,
            "total_orders": total_orders,
            "total_commission": total_commission,
            "avg_epc": round(avg_epc, 4),
            "avg_roi": round(avg_roi, 2)
        })
    
    return result


@router.get("/account-details")
async def get_account_details(
    account_id: int,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    current_user: User = Depends(get_current_manager),
    db: Session = Depends(get_db)
):
    """获取指定联盟账号的详细数据"""
    account = db.query(AffiliateAccount).filter(
        AffiliateAccount.id == account_id
    ).first()
    if not account:
        raise HTTPException(status_code=404, detail="联盟账号不存在")
    
    query = db.query(AnalysisResult).filter(
        AnalysisResult.affiliate_account_id == account_id
    )
    
    if start_date:
        query = query.filter(AnalysisResult.analysis_date >= start_date)
    if end_date:
        query = query.filter(AnalysisResult.analysis_date <= end_date)
    
    results = query.order_by(AnalysisResult.analysis_date.desc()).all()
    
    return {
        "account": {
            "id": account.id,
            "account_name": account.account_name,
            "platform": account.platform.platform_name
        },
        "results": [
            {
                "id": r.id,
                "analysis_date": r.analysis_date.isoformat(),
                "data": r.result_data
            }
            for r in results
        ]
    }




