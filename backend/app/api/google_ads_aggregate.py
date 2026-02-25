"""
Google Ads聚合数据API
完全对齐Google Ads的统计口径，使用predefined date ranges
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, and_
from typing import Optional
from datetime import datetime, timedelta, date
from pydantic import BaseModel

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.google_ads_api_data import GoogleAdsApiData, GoogleMccAccount
from app.models.affiliate_transaction import AffiliateTransaction
import re

router = APIRouter(prefix="/api/google-ads-aggregate", tags=["google-ads-aggregate"])

# 货币汇率配置
CNY_TO_USD_RATE = 7.2  # 人民币兑美元汇率


def get_mcc_currency_map(db: Session, user_id: int) -> dict:
    """获取用户所有MCC的货币映射"""
    mccs = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.user_id == user_id,
        GoogleMccAccount.is_active == True
    ).all()
    return {mcc.id: getattr(mcc, 'currency', 'USD') or 'USD' for mcc in mccs}


def convert_to_usd(amount: float, currency: str) -> float:
    """将金额转换为美元"""
    if currency == "CNY":
        return amount / CNY_TO_USD_RATE
    return amount


class DateRangeAggregateResponse(BaseModel):
    """日期范围聚合响应"""
    date_range_type: str  # past7days, thisWeek, thisMonth, custom
    date_range_label: str  # "过去 7 天", "本周", "本月", "自定义"
    begin_date: date
    end_date: date
    
    # Google Ads数据（聚合后的一行）
    google_ads_cost: float
    google_ads_impressions: int
    google_ads_clicks: int
    google_ads_cpc: float
    
    # 联盟数据（聚合后的一行）
    affiliate_commission: float  # 已确认佣金
    affiliate_rejected_commission: float  # 拒付佣金
    affiliate_orders: int  # 总订单数
    
    # 计算指标
    roi: float  # ROI = (已确认佣金 - 拒付佣金) / Google Ads成本
    net_commission: float  # 净佣金 = 已确认佣金 - 拒付佣金


def get_date_range_from_type(date_range_type: str) -> tuple[date, date, str]:
    """
    根据日期范围类型获取开始和结束日期
    
    完全对齐Google Ads的predefined date ranges
    
    Args:
        date_range_type: 日期范围类型
            - past7days: 过去7天（LAST_7_DAYS）
            - thisWeek: 本周（THIS_WEEK）
            - thisMonth: 本月（THIS_MONTH）
            - custom: 自定义（需要提供begin_date和end_date）
    
    Returns:
        (begin_date, end_date, label)
    """
    today = date.today()
    
    if date_range_type == "past7days":
        # 过去7天：从7天前到今天（包含今天）
        begin_date = today - timedelta(days=6)  # 包含今天，所以是6天前
        end_date = today
        return begin_date, end_date, "过去 7 天"
    
    elif date_range_type == "thisWeek":
        # 本周：从本周一开始到今天
        days_since_monday = today.weekday()  # 0=Monday, 6=Sunday
        begin_date = today - timedelta(days=days_since_monday)
        end_date = today
        return begin_date, end_date, "本周"
    
    elif date_range_type == "thisMonth":
        # 本月：从本月1号到今天
        begin_date = today.replace(day=1)
        end_date = today
        return begin_date, end_date, "本月"
    
    elif date_range_type == "today":
        begin_date = today
        end_date = today
        return begin_date, end_date, "今天"
    
    elif date_range_type == "yesterday":
        begin_date = today - timedelta(days=1)
        end_date = begin_date
        return begin_date, end_date, "昨天"
    
    else:
        raise HTTPException(status_code=400, detail=f"不支持的日期范围类型: {date_range_type}")


def _infer_platform_code_from_campaign_name(campaign_name: str) -> Optional[str]:
    """
    兜底：当GoogleAdsApiData.extracted_platform_code为空时，从广告系列名推断平台码。
    支持：001-LB1-xxx / 001_LB1_xxx / 001-LB-xxx
    """
    if not campaign_name:
        return None
    import re
    m = re.match(r"^\d+[_-]([A-Za-z]{2,3})\d*[_-]", campaign_name)
    if not m:
        return None
    return m.group(1).upper()


def _infer_merchant_id_from_campaign_name(campaign_name: str) -> Optional[str]:
    """
    从广告系列名推断商家ID（最后一个字段）。
    支持：001-LB1-xxx-US-1125-240088 / 001_LB1_xxx_US_1125_240088
    """
    if not campaign_name:
        return None
    parts = [p for p in re.split(r"[_-]", campaign_name) if p]
    if len(parts) < 2:
        return None
    last = parts[-1]
    return last if re.match(r"^\d+$", last) else None


def _normalize_status(status_value) -> tuple[str, str]:
    """
    统一状态：返回 (status_code, status_label)
    - status_code：ENABLED/PAUSED/REMOVED/UNKNOWN（用于筛选/排序）
    - status_label：已启用/已暂停/已移除/未知（用于展示）
    """
    # 处理数字状态（Google Ads API 枚举值）
    if isinstance(status_value, int) or (isinstance(status_value, str) and status_value.isdigit()):
        int_val = int(status_value)
        int_to_code = {2: "ENABLED", 3: "PAUSED", 4: "REMOVED"}
        code = int_to_code.get(int_val, "UNKNOWN")
        code_to_label = {"ENABLED": "已启用", "PAUSED": "已暂停", "REMOVED": "已移除", "UNKNOWN": "未知"}
        return code, code_to_label[code]
    
    raw = (str(status_value) if status_value else "").strip()
    upper = raw.upper()

    # 已经是中文（历史数据可能存中文）
    zh_to_code = {
        "已启用": "ENABLED",
        "已暂停": "PAUSED",
        "已停用": "PAUSED",
        "已移除": "REMOVED",
        "未知": "UNKNOWN",
    }
    if raw in zh_to_code:
        code = zh_to_code[raw]
        label = raw if raw != "已停用" else "已暂停"
        return code, label

    # 英文/枚举
    code_to_label = {
        "ENABLED": "已启用",
        "PAUSED": "已暂停",
        "REMOVED": "已移除",
        "UNKNOWN": "未知",
    }
    if upper in code_to_label:
        return upper, code_to_label[upper]

    return "UNKNOWN", (raw or "未知")


@router.get("/by-campaign")
async def get_campaign_data(
    date_range_type: str = Query(..., description="日期范围类型: past7days, thisWeek, thisMonth, today, yesterday, custom"),
    begin_date: Optional[str] = Query(None, description="自定义开始日期 YYYY-MM-DD（仅custom时使用）"),
    end_date: Optional[str] = Query(None, description="自定义结束日期 YYYY-MM-DD（仅custom时使用）"),
    mcc_id: Optional[int] = Query(None, description="MCC ID（可选）"),
    platform_code: Optional[str] = Query(None, description="平台代码（可选）"),
    status: Optional[str] = Query("ENABLED", description="广告系列状态（默认只显示已启用）：ENABLED/PAUSED/REMOVED/UNKNOWN/ALL"),
    merchant_id: Optional[str] = Query(None, description="商家ID（可选）：广告系列名最后一段ID"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    按广告系列分组获取数据
    
    返回格式：
    - 时间范围（x月x日-y月y日）
    - 广告系列
    - 预算
    - 费用
    - 展示次数
    - 点击次数
    - CPC
    - CTR
    - IS Budget丢失
    - IS Rank丢失
    """
    # 获取日期范围
    if date_range_type == "custom":
        if not begin_date or not end_date:
            raise HTTPException(status_code=400, detail="自定义日期范围需要提供begin_date和end_date")
        try:
            begin = datetime.strptime(begin_date, "%Y-%m-%d").date()
            end = datetime.strptime(end_date, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(status_code=400, detail="日期格式错误，应为 YYYY-MM-DD")
    else:
        begin, end, _ = get_date_range_from_type(date_range_type)
    
    # 按广告系列分组查询
    # 注意：预算(budget)是每日预算，使用最近一天的预算作为每日预算
    from app.models.affiliate_account import AffiliatePlatform
    
    # 获取用户所有MCC的货币映射
    mcc_currency_map = get_mcc_currency_map(db, current_user.id)
    
    query = db.query(
        GoogleAdsApiData.campaign_id,
        GoogleAdsApiData.campaign_name,
        GoogleAdsApiData.extracted_platform_code,
        GoogleAdsApiData.mcc_id,
        func.sum(GoogleAdsApiData.cost).label('total_cost'),
        func.sum(GoogleAdsApiData.impressions).label('total_impressions'),
        func.sum(GoogleAdsApiData.clicks).label('total_clicks'),
        func.avg(GoogleAdsApiData.cpc).label('avg_cpc')
    ).filter(
        GoogleAdsApiData.user_id == current_user.id,
        GoogleAdsApiData.date >= begin,
        GoogleAdsApiData.date <= end
    ).group_by(
        GoogleAdsApiData.campaign_id,
        GoogleAdsApiData.campaign_name,
        GoogleAdsApiData.extracted_platform_code,
        GoogleAdsApiData.mcc_id
    )
    
    # 权限检查
    if current_user.role in ("employee", "member", "leader"):
        query = query.filter(GoogleAdsApiData.user_id == current_user.id)
    
    # 筛选条件
    if mcc_id:
        query = query.filter(GoogleAdsApiData.mcc_id == mcc_id)
    
    results = query.all()
    
    # 获取每个广告系列最近一天的预算、状态、IS Budget丢失、IS Rank丢失（批量查询，提高性能）
    campaign_ids = [row.campaign_id for row in results]
    latest_budgets = {}
    latest_statuses = {}
    latest_is_budget_lost = {}
    latest_is_rank_lost = {}
    if campaign_ids:
        # 批量查询：为每个广告系列获取最近一天的数据
        # 使用子查询找到每个广告系列的最大日期，然后JOIN获取对应的数据
        from sqlalchemy import select, and_
        
        # 子查询：每个广告系列的最大日期
        max_date_subq = db.query(
            GoogleAdsApiData.campaign_id,
            func.max(GoogleAdsApiData.date).label('max_date')
        ).filter(
            GoogleAdsApiData.user_id == current_user.id,
            GoogleAdsApiData.campaign_id.in_(campaign_ids),
            GoogleAdsApiData.date >= begin,
            GoogleAdsApiData.date <= end
        ).group_by(GoogleAdsApiData.campaign_id).subquery()
        
        # 主查询：获取每个广告系列在最大日期那天的预算、状态、IS丢失数据
        latest_data_query = db.query(
            GoogleAdsApiData.campaign_id,
            GoogleAdsApiData.budget,
            GoogleAdsApiData.status,
            GoogleAdsApiData.is_budget_lost,
            GoogleAdsApiData.is_rank_lost
        ).join(
            max_date_subq,
            and_(
                GoogleAdsApiData.campaign_id == max_date_subq.c.campaign_id,
                GoogleAdsApiData.date == max_date_subq.c.max_date
            )
        ).filter(
            GoogleAdsApiData.user_id == current_user.id
        )
        
        for row in latest_data_query.all():
            latest_budgets[row.campaign_id] = float(row.budget or 0)
            latest_statuses[row.campaign_id] = row.status or "未知"
            latest_is_budget_lost[row.campaign_id] = float(row.is_budget_lost or 0)
            latest_is_rank_lost[row.campaign_id] = float(row.is_rank_lost or 0)
    
    # 格式化日期范围显示
    begin_str = begin.strftime("%m月%d日")
    end_str = end.strftime("%m月%d日")
    date_range_display = f"{begin_str}-{end_str}"
    
    # 获取平台信息映射
    platform_code_map = {}
    if results:
        platform_codes = [row.extracted_platform_code for row in results if row.extracted_platform_code]
        if platform_codes:
            platforms = db.query(AffiliatePlatform).filter(
                AffiliatePlatform.platform_code.in_(platform_codes)
            ).all()
            platform_code_map = {p.platform_code: p.platform_name for p in platforms}
    
    # 格式化数据（先按 mcc 维度转换货币，再按 campaign_id 合并去重）
    _campaign_buckets: dict = {}  # campaign_id -> merged dict
    for row in results:
        total_impressions = float(row.total_impressions or 0)
        total_clicks = float(row.total_clicks or 0)

        # 获取平台信息
        inferred_platform_code = row.extracted_platform_code or _infer_platform_code_from_campaign_name(row.campaign_name)
        row_platform_code = inferred_platform_code

        # 货币转换：如果是CNY则转换为USD
        currency = mcc_currency_map.get(row.mcc_id, "USD")
        raw_cost = float(row.total_cost or 0)
        raw_cpc = float(row.avg_cpc or 0)
        display_cost = convert_to_usd(raw_cost, currency)
        display_cpc = convert_to_usd(raw_cpc, currency)

        cid = row.campaign_id
        if cid in _campaign_buckets:
            b = _campaign_buckets[cid]
            b["_cost"] += display_cost
            b["_impressions"] += total_impressions
            b["_clicks"] += total_clicks
            b["_cpc_sum"] += display_cpc * total_clicks
            b["_currencies"].add(currency)
        else:
            _campaign_buckets[cid] = {
                "campaign_id": cid,
                "campaign_name": row.campaign_name,
                "platform_code": row_platform_code,
                "_cost": display_cost,
                "_impressions": total_impressions,
                "_clicks": total_clicks,
                "_cpc_sum": display_cpc * total_clicks,
                "_currencies": {currency},
            }

    # 组装最终返回列表
    campaign_data = []
    for cid, b in _campaign_buckets.items():
        total_clicks = b["_clicks"]
        total_impressions = b["_impressions"]
        ctr = (total_clicks / total_impressions * 100) if total_impressions > 0 else 0
        avg_cpc = (b["_cpc_sum"] / total_clicks) if total_clicks > 0 else 0

        daily_budget = latest_budgets.get(cid, 0)
        raw_status = latest_statuses.get(cid, "未知")
        status_code, status_label = _normalize_status(raw_status)

        platform_name = platform_code_map.get(b["platform_code"], b["platform_code"]) if b["platform_code"] else None
        inferred_mid = _infer_merchant_id_from_campaign_name(b["campaign_name"])

        # 预算也需要按其 MCC 货币转换；latest_budgets 存的是原始值
        # 这里使用第一个出现的货币做转换（绝大多数 campaign 只属于一个 MCC）
        budget_currency = next(iter(b["_currencies"]))
        display_budget = convert_to_usd(daily_budget, budget_currency)

        currencies = b["_currencies"]
        if len(currencies) == 1:
            out_currency = next(iter(currencies))
        else:
            out_currency = "MIXED"

        campaign_data.append({
            "date_range": date_range_display,
            "campaign_name": b["campaign_name"],
            "campaign_id": cid,
            "platform_code": b["platform_code"],
            "platform_name": platform_name,
            "status": status_label,
            "status_code": status_code,
            "merchant_id": inferred_mid,
            "budget": round(display_budget, 2),
            "cost": round(b["_cost"], 2),
            "impressions": int(total_impressions),
            "clicks": int(total_clicks),
            "cpc": round(avg_cpc, 4),
            "ctr": round(ctr, 2),
            "is_budget_lost": round(latest_is_budget_lost.get(cid, 0), 4),
            "is_rank_lost": round(latest_is_rank_lost.get(cid, 0), 4),
            "currency": out_currency,
        })

    # 平台筛选兜底：同时支持 extracted_platform_code 和从 campaign_name 推断的平台
    if platform_code:
        want = platform_code.upper()
        campaign_data = [c for c in campaign_data if (c.get("platform_code") or "").upper() == want]

    # 状态筛选：默认只显示ENABLED，传ALL显示所有状态
    if status and status.upper() != "ALL":
        want_s = status.upper()
        campaign_data = [c for c in campaign_data if (c.get("status_code") or "").upper() == want_s]

    if merchant_id:
        want_mid = str(merchant_id).strip()
        campaign_data = [c for c in campaign_data if str(c.get("merchant_id") or "").strip() == want_mid]
    
    return {
        "begin_date": begin.strftime("%Y-%m-%d"),
        "end_date": end.strftime("%Y-%m-%d"),
        "date_range_display": date_range_display,
        "campaigns": campaign_data
    }


@router.get("", response_model=DateRangeAggregateResponse)
@router.get("/", response_model=DateRangeAggregateResponse)
async def get_date_range_aggregate(
    date_range_type: str = Query(..., description="日期范围类型: past7days, thisWeek, thisMonth, today, yesterday, custom"),
    begin_date: Optional[str] = Query(None, description="自定义开始日期 YYYY-MM-DD（仅custom时使用）"),
    end_date: Optional[str] = Query(None, description="自定义结束日期 YYYY-MM-DD（仅custom时使用）"),
    mcc_id: Optional[int] = Query(None, description="MCC ID（可选）"),
    platform_code: Optional[str] = Query(None, description="平台代码（可选）"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    获取日期范围级别的聚合数据
    
    完全对齐Google Ads的统计口径：
    - 不按天拆分
    - 直接返回时间范围级别的聚合结果
    - 一行数据，不是多行加总
    
    这是财务级口径，确保与Google Ads UI完全一致。
    """
    # 获取日期范围
    if date_range_type == "custom":
        if not begin_date or not end_date:
            raise HTTPException(status_code=400, detail="自定义日期范围需要提供begin_date和end_date")
        try:
            begin = datetime.strptime(begin_date, "%Y-%m-%d").date()
            end = datetime.strptime(end_date, "%Y-%m-%d").date()
            date_range_label = f"{begin_date} ~ {end_date}"
        except ValueError:
            raise HTTPException(status_code=400, detail="日期格式错误，应为 YYYY-MM-DD")
    else:
        begin, end, date_range_label = get_date_range_from_type(date_range_type)
    
    # ========== Google Ads数据聚合（不按天拆分，直接聚合）==========
    google_ads_query = db.query(
        func.sum(GoogleAdsApiData.cost).label('total_cost'),
        func.sum(GoogleAdsApiData.impressions).label('total_impressions'),
        func.sum(GoogleAdsApiData.clicks).label('total_clicks')
    ).join(
        GoogleMccAccount
    ).filter(
        GoogleAdsApiData.user_id == current_user.id,
        GoogleAdsApiData.date >= begin,
        GoogleAdsApiData.date <= end
    )
    
    # 权限检查
    if current_user.role in ("employee", "member", "leader"):
        google_ads_query = google_ads_query.filter(GoogleAdsApiData.user_id == current_user.id)
    
    # 筛选条件
    if mcc_id:
        google_ads_query = google_ads_query.filter(GoogleAdsApiData.mcc_id == mcc_id)
    
    if platform_code:
        google_ads_query = google_ads_query.filter(GoogleAdsApiData.extracted_platform_code == platform_code)
    
    google_ads_result = google_ads_query.first()
    
    google_ads_cost = float(google_ads_result.total_cost or 0)
    google_ads_impressions = int(google_ads_result.total_impressions or 0)
    google_ads_clicks = int(google_ads_result.total_clicks or 0)
    google_ads_cpc = google_ads_cost / google_ads_clicks if google_ads_clicks > 0 else 0
    
    # ========== 联盟数据聚合（使用相同的时间窗口，不按天拆分）==========
    # 使用transaction_time >= begin的00:00:00，<= end的23:59:59
    begin_datetime = datetime.combine(begin, datetime.min.time())
    end_datetime = datetime.combine(end, datetime.max.time())
    
    # 基础查询条件
    base_filter = and_(
        AffiliateTransaction.transaction_time >= begin_datetime,
        AffiliateTransaction.transaction_time <= end_datetime
    )
    
    # 权限检查
    if current_user.role in ("employee", "member", "leader"):
        base_filter = and_(base_filter, AffiliateTransaction.user_id == current_user.id)
    
    # 筛选条件
    if platform_code:
        base_filter = and_(base_filter, AffiliateTransaction.platform == platform_code)
    
    # 已确认佣金（status = approved）
    approved_query = db.query(
        func.sum(AffiliateTransaction.commission_amount).label('total_commission'),
        func.count(AffiliateTransaction.id).label('total_orders')
    ).filter(
        and_(base_filter, AffiliateTransaction.status == "approved")
    )
    approved_result = approved_query.first()
    affiliate_commission = float(approved_result.total_commission or 0)
    affiliate_orders = int(approved_result.total_orders or 0)
    
    # 拒付佣金（status = rejected）
    rejected_query = db.query(
        func.sum(AffiliateTransaction.commission_amount).label('rejected_commission')
    ).filter(
        and_(base_filter, AffiliateTransaction.status == "rejected")
    )
    rejected_result = rejected_query.first()
    affiliate_rejected_commission = float(rejected_result.rejected_commission or 0)
    
    # 计算ROI（使用聚合后的数据，不是逐日加总）
    net_commission = affiliate_commission - affiliate_rejected_commission
    roi = (net_commission / google_ads_cost * 100) if google_ads_cost > 0 else 0
    
    return {
        "date_range_type": date_range_type,
        "date_range_label": date_range_label,
        "begin_date": begin,
        "end_date": end,
        "google_ads_cost": round(google_ads_cost, 2),
        "google_ads_impressions": google_ads_impressions,
        "google_ads_clicks": google_ads_clicks,
        "google_ads_cpc": round(google_ads_cpc, 4),
        "affiliate_commission": round(affiliate_commission, 2),
        "affiliate_rejected_commission": round(affiliate_rejected_commission, 2),
        "affiliate_orders": affiliate_orders,
        "roi": round(roi, 2),
        "net_commission": round(net_commission, 2)
    }


def _do_google_ads_sync_background(user_id: int, mcc_ids: list, start_date: str, end_date: str):
    """在后台线程中执行Google Ads同步"""
    import logging
    from datetime import datetime
    from app.database import SessionLocal
    from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
    
    logger = logging.getLogger(__name__)
    logger.info(f"[后台同步] 开始Google Ads同步，用户ID: {user_id}, MCC数量: {len(mcc_ids)}")
    
    db = SessionLocal()
    try:
        sync_service = GoogleAdsServiceAccountSync(db)
        start_dt = datetime.strptime(start_date, "%Y-%m-%d").date()
        end_dt = datetime.strptime(end_date, "%Y-%m-%d").date()
        
        total_synced = 0
        synced_mccs = 0
        
        for mcc_id in mcc_ids:
            try:
                mcc = db.query(GoogleMccAccount).filter(GoogleMccAccount.id == mcc_id).first()
                if not mcc:
                    continue
                    
                mcc_synced = 0
                current_date = start_dt
                while current_date <= end_dt:
                    result = sync_service.sync_mcc_data(
                        mcc_id=mcc.id,
                        target_date=current_date,
                        force_refresh=True
                    )
                    if result.get("success"):
                        mcc_synced += result.get("campaigns_synced", 0)
                    current_date += timedelta(days=1)
                
                synced_mccs += 1
                total_synced += mcc_synced
                logger.info(f"[后台同步] MCC {mcc.mcc_name} 同步完成: {mcc_synced} 条记录")
                
            except Exception as e:
                logger.error(f"[后台同步] 同步MCC ID {mcc_id} 失败: {e}")
        
        logger.info(f"[后台同步] Google Ads同步完成: {synced_mccs}/{len(mcc_ids)} 个MCC, {total_synced} 条记录")
        
    except Exception as e:
        logger.error(f"[后台同步] Google Ads同步出错: {e}", exc_info=True)
    finally:
        db.close()


@router.post("/sync-realtime")
async def sync_google_ads_realtime(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    实时同步Google Ads数据（最近3天）- 后台任务模式
    立即返回，同步在后台执行
    """
    import logging
    import threading
    
    logger = logging.getLogger(__name__)
    
    try:
        # 计算最近3天的日期范围
        end_date = date.today()
        start_date = end_date - timedelta(days=2)  # 今天 + 前2天 = 3天
        
        logger.info(f"用户 {current_user.username} 触发Google Ads实时同步（后台模式），日期范围: {start_date} ~ {end_date}")
        
        # 获取用户的所有MCC账号
        mccs = db.query(GoogleMccAccount).filter(
            GoogleMccAccount.user_id == current_user.id,
            GoogleMccAccount.is_active == True
        ).all()
        
        if not mccs:
            return {
                "success": True,
                "message": "没有找到活跃的MCC账号",
                "synced_mccs": 0,
                "total_mccs": 0,
                "total_records": 0
            }
        
        mcc_ids = [mcc.id for mcc in mccs]
        
        # 使用线程池在后台执行同步
        sync_thread = threading.Thread(
            target=_do_google_ads_sync_background,
            args=(current_user.id, mcc_ids, start_date.strftime("%Y-%m-%d"), end_date.strftime("%Y-%m-%d"))
        )
        sync_thread.daemon = True
        sync_thread.start()
        
        return {
            "success": True,
            "message": f"同步已在后台开始，正在同步 {len(mccs)} 个MCC，请稍后刷新页面查看结果",
            "synced_mccs": 0,
            "total_mccs": len(mccs),
            "total_records": 0,
            "date_range": f"{start_date} ~ {end_date}",
            "background": True
        }
        
    except Exception as e:
        logger.error(f"启动Google Ads后台同步失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"启动同步失败: {str(e)}")
