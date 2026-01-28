"""
我的费用 API
从分析结果中按日期/平台聚合佣金与广告费用，并支持录入拒付佣金
"""
from __future__ import annotations

from typing import Optional, Dict, Tuple, List
from datetime import datetime, date

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.analysis_result import AnalysisResult
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.expense_adjustment import ExpenseAdjustment
from app.schemas.expenses import (
    ExpenseSummaryResponse,
    ExpenseTotals,
    ExpensePlatformSummary,
    ExpenseAdjustmentUpsert,
    ExpenseDailyResponse,
    ExpenseDailyRow,
)

router = APIRouter(prefix="/api/expenses", tags=["expenses"])


def _parse_date(s: str) -> date:
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except Exception:
        raise HTTPException(status_code=400, detail="日期格式错误，请使用YYYY-MM-DD")


def _safe_float(v) -> float:
    try:
        if v is None:
            return 0.0
        return float(v)
    except Exception:
        return 0.0


def _extract_commission_cost(result_data: dict) -> Tuple[float, float]:
    """
    从单次分析结果 result_data.data 里汇总：
    - 佣金：字段名优先 '佣金'，兼容 '回传佣金'
    - 广告费用：字段名 '费用'
    """
    data = (result_data or {}).get("data") or []
    if not isinstance(data, list):
        return 0.0, 0.0
    commission = 0.0
    cost = 0.0
    for row in data:
        if not isinstance(row, dict):
            continue
        commission += _safe_float(row.get("佣金", row.get("回传佣金", 0)))
        cost += _safe_float(row.get("费用", 0))
    return commission, cost


@router.post("/rejected-commission", status_code=status.HTTP_200_OK)
async def upsert_rejected_commission(
    payload: ExpenseAdjustmentUpsert,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """录入/更新某平台某日的拒付佣金"""
    d = _parse_date(payload.date)
    platform = db.query(AffiliatePlatform).filter(AffiliatePlatform.id == payload.platform_id).first()
    if not platform:
        raise HTTPException(status_code=404, detail="平台不存在")

    adj = db.query(ExpenseAdjustment).filter(
        ExpenseAdjustment.user_id == current_user.id,
        ExpenseAdjustment.platform_id == payload.platform_id,
        ExpenseAdjustment.date == d,
    ).first()
    if not adj:
        adj = ExpenseAdjustment(
            user_id=current_user.id,
            platform_id=payload.platform_id,
            date=d,
            rejected_commission=float(payload.rejected_commission or 0.0),
        )
        db.add(adj)
    else:
        adj.rejected_commission = float(payload.rejected_commission or 0.0)

    db.commit()
    return {"message": "保存成功"}


@router.get("/summary", response_model=ExpenseSummaryResponse)
async def get_expense_summary(
    start_date: str,
    end_date: str,
    today_date: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    获取费用汇总：
    - 按平台：当天佣金/当天费用/当天拒付/当天净利润 + 区间累计
    - 总计：总佣金/总费用/总拒付/净利润/平均每日收益
    """
    start = _parse_date(start_date)
    end = _parse_date(end_date)
    if end < start:
        raise HTTPException(status_code=400, detail="结束日期不能早于开始日期")

    today = _parse_date(today_date) if today_date else end

    # 查询区间内分析结果（员工只看自己的）
    results = db.query(AnalysisResult).join(AffiliateAccount).join(AffiliatePlatform).filter(
        AnalysisResult.user_id == current_user.id,
        AnalysisResult.analysis_date >= start,
        AnalysisResult.analysis_date <= end,
    ).all()

    # 聚合：platform_id -> {date -> (commission, cost)}
    platform_map: Dict[int, Dict[str, object]] = {}
    day_set = set()
    for r in results:
        platform = r.affiliate_account.platform
        pid = platform.id if platform else None
        if pid is None:
            continue
        d = r.analysis_date
        day_set.add(d)
        commission, cost = _extract_commission_cost(r.result_data)
        if pid not in platform_map:
            platform_map[pid] = {
                "platform_id": pid,
                "platform_name": platform.platform_name,
                "by_date": {},  # date -> [commission, cost]
            }
        by_date = platform_map[pid]["by_date"]
        if d not in by_date:
            by_date[d] = [0.0, 0.0]
        by_date[d][0] += commission
        by_date[d][1] += cost

    # 拉取拒付佣金调整（区间内）
    adjustments = db.query(ExpenseAdjustment).filter(
        ExpenseAdjustment.user_id == current_user.id,
        ExpenseAdjustment.date >= start,
        ExpenseAdjustment.date <= end,
    ).all()
    adj_map: Dict[Tuple[int, date], float] = {}
    for a in adjustments:
        adj_map[(a.platform_id, a.date)] = float(a.rejected_commission or 0.0)

    # 组装平台汇总
    platforms: List[ExpensePlatformSummary] = []
    total_commission = 0.0
    total_cost = 0.0
    total_rejected = 0.0

    for pid, info in sorted(platform_map.items(), key=lambda kv: kv[0]):
        by_date = info["by_date"]

        # 当天
        today_commission = 0.0
        today_cost = 0.0
        if today in by_date:
            today_commission, today_cost = by_date[today][0], by_date[today][1]
        today_rejected = adj_map.get((pid, today), 0.0)
        today_net = today_commission - today_rejected - today_cost

        # 区间累计
        range_commission = sum(v[0] for v in by_date.values())
        range_cost = sum(v[1] for v in by_date.values())
        range_rejected = sum(adj_map.get((pid, d), 0.0) for d in by_date.keys())
        range_net = range_commission - range_rejected - range_cost

        total_commission += range_commission
        total_cost += range_cost
        total_rejected += range_rejected

        platforms.append(ExpensePlatformSummary(
            platform_id=pid,
            platform_name=info["platform_name"],
            today_commission=round(today_commission, 4),
            today_ad_cost=round(today_cost, 4),
            today_rejected_commission=round(today_rejected, 4),
            today_net_profit=round(today_net, 4),
            range_commission=round(range_commission, 4),
            range_ad_cost=round(range_cost, 4),
            range_rejected_commission=round(range_rejected, 4),
            range_net_profit=round(range_net, 4),
        ))

    day_count = len(day_set) if len(day_set) > 0 else 0
    net_profit = total_commission - total_rejected - total_cost
    avg_daily = (net_profit / day_count) if day_count > 0 else 0.0

    totals = ExpenseTotals(
        total_commission=round(total_commission, 4),
        total_ad_cost=round(total_cost, 4),
        total_rejected_commission=round(total_rejected, 4),
        net_profit=round(net_profit, 4),
        avg_daily_profit=round(avg_daily, 4),
        day_count=day_count,
    )

    return ExpenseSummaryResponse(
        start_date=start.strftime("%Y-%m-%d"),
        end_date=end.strftime("%Y-%m-%d"),
        today_date=today.strftime("%Y-%m-%d"),
        platforms=platforms,
        totals=totals,
    )


@router.get("/daily", response_model=ExpenseDailyResponse)
async def get_expense_daily(
    start_date: str,
    end_date: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """按天明细（用于某一日期/某一阶段查看）"""
    start = _parse_date(start_date)
    end = _parse_date(end_date)
    if end < start:
        raise HTTPException(status_code=400, detail="结束日期不能早于开始日期")

    results = db.query(AnalysisResult).join(AffiliateAccount).join(AffiliatePlatform).filter(
        AnalysisResult.user_id == current_user.id,
        AnalysisResult.analysis_date >= start,
        AnalysisResult.analysis_date <= end,
    ).all()

    adjustments = db.query(ExpenseAdjustment).filter(
        ExpenseAdjustment.user_id == current_user.id,
        ExpenseAdjustment.date >= start,
        ExpenseAdjustment.date <= end,
    ).all()
    adj_map: Dict[Tuple[int, date], float] = {(a.platform_id, a.date): float(a.rejected_commission or 0.0) for a in adjustments}

    rows: List[ExpenseDailyRow] = []
    for r in results:
        platform = r.affiliate_account.platform
        if not platform:
            continue
        pid = platform.id
        d = r.analysis_date
        commission, cost = _extract_commission_cost(r.result_data)
        rejected = adj_map.get((pid, d), 0.0)
        net = commission - rejected - cost
        rows.append(ExpenseDailyRow(
            date=d.strftime("%Y-%m-%d"),
            platform_id=pid,
            platform_name=platform.platform_name,
            commission=round(commission, 4),
            ad_cost=round(cost, 4),
            rejected_commission=round(rejected, 4),
            net_profit=round(net, 4),
        ))

    # 排序：日期 desc, 平台 asc
    rows.sort(key=lambda x: (x.date, x.platform_id), reverse=True)
    return ExpenseDailyResponse(
        start_date=start.strftime("%Y-%m-%d"),
        end_date=end.strftime("%Y-%m-%d"),
        rows=rows,
    )


