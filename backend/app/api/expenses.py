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
from app.models.platform_data import PlatformData
from app.models.google_ads_api_data import GoogleAdsApiData
from app.models.expense_adjustment import ExpenseAdjustment
from app.schemas.expenses import (
    ExpenseSummaryResponse,
    ExpenseTotals,
    ExpensePlatformSummary,
    ExpenseAdjustmentUpsert,
    ExpenseDailyResponse,
    ExpenseDailyRow,
    ExpenseManagerSummaryResponse,
    ExpenseUserSummary,
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


def _extract_commission_cost_from_daily_metrics(data: list) -> Tuple[float, float]:
    """
    从 AdCampaignDailyMetric 列表中汇总佣金/花费
    """
    commission = 0.0
    cost = 0.0
    for m in data or []:
        try:
            commission += float(getattr(m, "commission", 0) or 0.0)
        except Exception:
            pass
        try:
            cost += float(getattr(m, "cost", 0) or 0.0)
        except Exception:
            pass
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


async def _get_manager_expense_summary(start: date, end: date, today: date, db: Session):
    """经理查看所有员工的费用汇总"""
    from app.models.user import User as UserModel
    from app.models.ad_campaign import AdCampaign
    from app.models.ad_campaign_daily_metric import AdCampaignDailyMetric
    
    # 获取所有员工
    employees = db.query(UserModel).filter(UserModel.role == "employee").all()
    
    # 获取所有平台
    platform_rows = db.query(AffiliatePlatform).all()
    platform_name_map = {p.id: p.platform_name for p in platform_rows}
    
    # 所有员工的总计
    all_total_commission = 0.0
    all_total_cost = 0.0
    all_total_rejected = 0.0
    all_day_set = set()
    
    # 按员工汇总
    user_summaries: List[ExpenseUserSummary] = []
    
    for employee in employees:
        # 获取该员工的每日指标
        metrics = db.query(AdCampaignDailyMetric).join(AdCampaign).filter(
            AdCampaignDailyMetric.user_id == employee.id,
            AdCampaignDailyMetric.date >= start,
            AdCampaignDailyMetric.date <= end,
        ).all()
        
        # 获取该员工的拒付佣金调整
        adjustments = db.query(ExpenseAdjustment).filter(
            ExpenseAdjustment.user_id == employee.id,
            ExpenseAdjustment.date >= start,
            ExpenseAdjustment.date <= end,
        ).all()
        adj_map: Dict[Tuple[int, date], float] = {}
        for a in adjustments:
            adj_map[(a.platform_id, a.date)] = float(a.rejected_commission or 0.0)
        
        # 按平台汇总该员工的数据
        platform_map: Dict[int, Dict[str, object]] = {}
        day_set = set()
        
        for m in metrics:
            campaign = db.query(AdCampaign).filter(AdCampaign.id == m.campaign_id).first()
            if not campaign:
                continue
            pid = campaign.platform_id
            d = m.date
            day_set.add(d)
            all_day_set.add(d)
            
            if pid not in platform_map:
                platform_map[pid] = {
                    "platform_id": pid,
                    "platform_name": platform_name_map.get(pid, f"平台{pid}"),
                    "by_date": {},
                }
            by_date = platform_map[pid]["by_date"]
            if d not in by_date:
                by_date[d] = [0.0, 0.0]
            by_date[d][0] += float(m.commission or 0.0)
            by_date[d][1] += float(m.cost or 0.0)
        
        # 如果没有每日指标，尝试从分析结果获取
        if not metrics:
            results = db.query(AnalysisResult).join(AffiliateAccount).join(AffiliatePlatform).filter(
                AnalysisResult.user_id == employee.id,
                AnalysisResult.analysis_date >= start,
                AnalysisResult.analysis_date <= end,
            ).all()
            
            for r in results:
                platform = r.affiliate_account.platform
                pid = platform.id if platform else None
                if pid is None:
                    continue
                d = r.analysis_date
                day_set.add(d)
                all_day_set.add(d)
                commission, cost = _extract_commission_cost(r.result_data)
                if pid not in platform_map:
                    platform_map[pid] = {
                        "platform_id": pid,
                        "platform_name": platform.platform_name,
                        "by_date": {},
                    }
                by_date = platform_map[pid]["by_date"]
                if d not in by_date:
                    by_date[d] = [0.0, 0.0]
                by_date[d][0] += commission
                by_date[d][1] += cost
        
        # 组装该员工的平台汇总
        user_platforms: List[ExpensePlatformSummary] = []
        user_total_commission = 0.0
        user_total_cost = 0.0
        user_total_rejected = 0.0
        
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
            
            user_total_commission += range_commission
            user_total_cost += range_cost
            user_total_rejected += range_rejected
            
            user_platforms.append(ExpensePlatformSummary(
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
        
        all_total_commission += user_total_commission
        all_total_cost += user_total_cost
        all_total_rejected += user_total_rejected
        
        user_summaries.append(ExpenseUserSummary(
            user_id=employee.id,
            username=employee.username,
            total_commission=round(user_total_commission, 4),
            total_ad_cost=round(user_total_cost, 4),
            total_rejected_commission=round(user_total_rejected, 4),
            net_profit=round(user_total_commission - user_total_rejected - user_total_cost, 4),
            platforms=user_platforms,
        ))
    
    # 计算总计
    day_count = len(all_day_set) if len(all_day_set) > 0 else 0
    net_profit = all_total_commission - all_total_rejected - all_total_cost
    avg_daily = (net_profit / day_count) if day_count > 0 else 0.0
    
    totals = ExpenseTotals(
        total_commission=round(all_total_commission, 4),
        total_ad_cost=round(all_total_cost, 4),
        total_rejected_commission=round(all_total_rejected, 4),
        net_profit=round(net_profit, 4),
        avg_daily_profit=round(avg_daily, 4),
        day_count=day_count,
    )
    
    return ExpenseManagerSummaryResponse(
        start_date=start.strftime("%Y-%m-%d"),
        end_date=end.strftime("%Y-%m-%d"),
        today_date=today.strftime("%Y-%m-%d"),
        totals=totals,
        users=user_summaries,
    )


@router.get("/summary")
async def get_expense_summary(
    start_date: str,
    end_date: str,
    today_date: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    获取费用汇总：
    - 员工：返回 ExpenseSummaryResponse（按平台汇总）
    - 经理：返回 ExpenseManagerSummaryResponse（所有员工汇总 + 按员工汇总 + 按员工+平台明细）
    """
    from app.models.user import User as UserModel
    start = _parse_date(start_date)
    end = _parse_date(end_date)
    if end < start:
        raise HTTPException(status_code=400, detail="结束日期不能早于开始日期")

    today = _parse_date(today_date) if today_date else end

    # 优先使用"每日指标"作为费用来源（更贴近"每日表格分析"的需求）
    # 若未写入每日指标，则退回到旧逻辑：从分析结果 JSON 聚合
    from app.models.ad_campaign import AdCampaign
    from app.models.ad_campaign_daily_metric import AdCampaignDailyMetric

    # 如果是经理，返回所有员工的数据
    if current_user.role == "manager":
        return await _get_manager_expense_summary(start, end, today, db)
    
    # 员工：返回自己的数据
    # platform_id -> platform_name
    platform_map: Dict[int, Dict[str, object]] = {}
    day_set = set()

    # ===== 先从平台API同步的数据中统计“佣金”（PlatformData），用于覆盖旧逻辑 =====
    # 账号 -> 平台 映射
    accounts = db.query(AffiliateAccount).filter(
        AffiliateAccount.user_id == current_user.id
    ).all()
    account_platform_map: Dict[int, int] = {
        a.id: a.platform_id for a in accounts
    }

    # 平台名称映射
    platform_rows = db.query(AffiliatePlatform).all()
    platform_name_map = {p.id: p.platform_name for p in platform_rows}
    platform_code_map = {p.platform_code: p.id for p in platform_rows}

    # (platform_id, date) -> commission_from_api
    api_commission_map: Dict[Tuple[int, date], float] = {}
    platform_data_rows = db.query(PlatformData).filter(
        PlatformData.user_id == current_user.id,
        PlatformData.date >= start,
        PlatformData.date <= end,
    ).all()
    for pd in platform_data_rows:
        pid = account_platform_map.get(pd.affiliate_account_id)
        if not pid:
            continue
        key = (pid, pd.date)
        api_commission_map[key] = api_commission_map.get(key, 0.0) + float(pd.commission or 0.0)
        day_set.add(pd.date)

    # ===== 从 Google Ads API 数据中统计“广告费用”（GoogleAdsApiData），覆盖旧逻辑 =====
    ga_cost_map: Dict[Tuple[int, date], float] = {}
    ga_unmatched_cost_map: Dict[date, float] = {}  # 未匹配平台的费用，按日期汇总
    ga_rows = db.query(GoogleAdsApiData).filter(
        GoogleAdsApiData.user_id == current_user.id,
        GoogleAdsApiData.date >= start,
        GoogleAdsApiData.date <= end,
    ).all()
    for row in ga_rows:
        platform_code = row.extracted_platform_code
        cost = float(row.cost or 0.0)
        day_set.add(row.date)
        
        if platform_code:
            pid = platform_code_map.get(platform_code)
            if pid:
                # 已匹配到平台，按平台统计
                key = (pid, row.date)
                ga_cost_map[key] = ga_cost_map.get(key, 0.0) + cost
            else:
                # 平台代码存在但无法匹配到平台ID，计入未匹配
                ga_unmatched_cost_map[row.date] = ga_unmatched_cost_map.get(row.date, 0.0) + cost
        else:
            # 没有平台代码，计入未匹配
            ga_unmatched_cost_map[row.date] = ga_unmatched_cost_map.get(row.date, 0.0) + cost

    # 1) 从每日指标聚合（仅作为费用的补充/兜底，优先使用Google Ads API）
    metrics = db.query(AdCampaignDailyMetric).join(AdCampaign).filter(
        AdCampaignDailyMetric.user_id == current_user.id,
        AdCampaignDailyMetric.date >= start,
        AdCampaignDailyMetric.date <= end,
    ).all()

    if metrics:
        for m in metrics:
            campaign = db.query(AdCampaign).filter(AdCampaign.id == m.campaign_id).first()
            if not campaign:
                continue
            pid = campaign.platform_id
            d = m.date
            day_set.add(d)

            if pid not in platform_map:
                platform_map[pid] = {
                    "platform_id": pid,
                    "platform_name": platform_name_map.get(pid, f"平台{pid}"),
                    "by_date": {},
                }
            by_date = platform_map[pid]["by_date"]
            if d not in by_date:
                by_date[d] = [0.0, 0.0]  # [commission, cost]
            # 费用来自每日指标（若该天该平台没有Google Ads数据时作为兜底）
            by_date[d][1] += float(m.cost or 0.0)
    else:
        # 2) 旧逻辑（兼容）：查询区间内分析结果（员工只看自己的）
        results = db.query(AnalysisResult).join(AffiliateAccount).join(AffiliatePlatform).filter(
            AnalysisResult.user_id == current_user.id,
            AnalysisResult.analysis_date >= start,
            AnalysisResult.analysis_date <= end,
        ).all()

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
            # 费用仍然沿用旧逻辑（若该天该平台没有Google Ads数据时作为兜底）
            by_date[d][1] += cost

    # 使用 PlatformData 中的佣金覆盖旧逻辑的佣金（佣金直接来自各平台API）
    for (pid, d), api_comm in api_commission_map.items():
        if pid not in platform_map:
            platform_map[pid] = {
                "platform_id": pid,
                "platform_name": platform_name_map.get(pid, f"平台{pid}"),
                "by_date": {},
            }
        by_date = platform_map[pid]["by_date"]
        if d not in by_date:
            by_date[d] = [0.0, 0.0]
        by_date[d][0] = api_comm  # 覆盖佣金

    # 使用 Google Ads API 中的费用覆盖旧逻辑的费用（广告费用直接来自Google Ads）
    for (pid, d), ga_cost in ga_cost_map.items():
        if pid not in platform_map:
            platform_map[pid] = {
                "platform_id": pid,
                "platform_name": platform_name_map.get(pid, f"平台{pid}"),
                "by_date": {},
            }
        by_date = platform_map[pid]["by_date"]
        if d not in by_date:
            by_date[d] = [0.0, 0.0]
        by_date[d][1] = ga_cost  # 覆盖费用
    
    # 将未匹配平台的费用也计入总费用（但不分配到具体平台）
    # 这些费用会在总费用中体现，但不会出现在按平台汇总中
    for d, unmatched_cost in ga_unmatched_cost_map.items():
        day_set.add(d)
        # 未匹配的费用计入总费用，但不分配到具体平台
        # 这样总费用就能与Google Ads数据页面对上了

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

    # 将未匹配平台的费用也计入总费用
    unmatched_total_cost = sum(ga_unmatched_cost_map.values())
    total_cost += unmatched_total_cost
    
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

    from app.models.ad_campaign import AdCampaign
    from app.models.ad_campaign_daily_metric import AdCampaignDailyMetric

    # 从平台API数据中统计每日“佣金”（PlatformData），用于覆盖旧逻辑
    accounts = db.query(AffiliateAccount).filter(
        AffiliateAccount.user_id == current_user.id
    ).all()
    account_platform_map: Dict[int, int] = {
        a.id: a.platform_id for a in accounts
    }
    platform_rows = db.query(AffiliatePlatform).all()
    platform_name_map = {p.id: p.platform_name for p in platform_rows}
    platform_code_map = {p.platform_code: p.id for p in platform_rows}

    api_commission_map: Dict[Tuple[int, date], float] = {}
    platform_data_rows = db.query(PlatformData).filter(
        PlatformData.user_id == current_user.id,
        PlatformData.date >= start,
        PlatformData.date <= end,
    ).all()
    for pd in platform_data_rows:
        pid = account_platform_map.get(pd.affiliate_account_id)
        if not pid:
            continue
        key = (pid, pd.date)
        api_commission_map[key] = api_commission_map.get(key, 0.0) + float(pd.commission or 0.0)

    # 从 Google Ads API 统计每日“广告费用”（GoogleAdsApiData），用于覆盖旧逻辑
    ga_cost_map: Dict[Tuple[int, date], float] = {}
    ga_unmatched_cost_map: Dict[date, float] = {}  # 未匹配平台的费用，按日期汇总
    ga_rows = db.query(GoogleAdsApiData).filter(
        GoogleAdsApiData.user_id == current_user.id,
        GoogleAdsApiData.date >= start,
        GoogleAdsApiData.date <= end,
    ).all()
    for row in ga_rows:
        platform_code = row.extracted_platform_code
        cost = float(row.cost or 0.0)
        
        if platform_code:
            pid = platform_code_map.get(platform_code)
            if pid:
                # 已匹配到平台，按平台统计
                key = (pid, row.date)
                ga_cost_map[key] = ga_cost_map.get(key, 0.0) + cost
            else:
                # 平台代码存在但无法匹配到平台ID，计入未匹配
                ga_unmatched_cost_map[row.date] = ga_unmatched_cost_map.get(row.date, 0.0) + cost
        else:
            # 没有平台代码，计入未匹配
            ga_unmatched_cost_map[row.date] = ga_unmatched_cost_map.get(row.date, 0.0) + cost

    # 优先：每日指标 -> 按平台/日期汇总广告费用（若某天某平台没有Google Ads数据时作为兜底）
    metrics = db.query(AdCampaignDailyMetric).join(AdCampaign).filter(
        AdCampaignDailyMetric.user_id == current_user.id,
        AdCampaignDailyMetric.date >= start,
        AdCampaignDailyMetric.date <= end,
    ).all()

    adjustments = db.query(ExpenseAdjustment).filter(
        ExpenseAdjustment.user_id == current_user.id,
        ExpenseAdjustment.date >= start,
        ExpenseAdjustment.date <= end,
    ).all()
    adj_map: Dict[Tuple[int, date], float] = {(a.platform_id, a.date): float(a.rejected_commission or 0.0) for a in adjustments}

    rows: List[ExpenseDailyRow] = []
    if metrics:
        # 聚合 (pid, date) -> [commission, cost]，其中佣金稍后由PlatformData覆盖
        agg: Dict[Tuple[int, date], List[float]] = {}
        for m in metrics:
            campaign = db.query(AdCampaign).filter(AdCampaign.id == m.campaign_id).first()
            if not campaign:
                continue
            pid = campaign.platform_id
            key = (pid, m.date)
            if key not in agg:
                agg[key] = [0.0, 0.0]
            # 费用来自每日指标（若无Google Ads数据时兜底）
            agg[key][1] += float(m.cost or 0.0)

        for (pid, d), (commission_cost) in agg.items():
            api_comm = api_commission_map.get((pid, d), 0.0)
            commission = api_comm
            # 优先使用Google Ads API的费用
            cost = ga_cost_map.get((pid, d), commission_cost[1])
            rejected = adj_map.get((pid, d), 0.0)
            net = commission - rejected - cost
            rows.append(ExpenseDailyRow(
                date=d.strftime("%Y-%m-%d"),
                platform_id=pid,
                platform_name=platform_name_map.get(pid, f"平台{pid}"),
                commission=round(commission, 4),
                ad_cost=round(cost, 4),
                rejected_commission=round(rejected, 4),
                net_profit=round(net, 4),
            ))
    else:
        # 兼容旧逻辑：从分析结果聚合
        results = db.query(AnalysisResult).join(AffiliateAccount).join(AffiliatePlatform).filter(
            AnalysisResult.user_id == current_user.id,
            AnalysisResult.analysis_date >= start,
            AnalysisResult.analysis_date <= end,
        ).all()

        for r in results:
            platform = r.affiliate_account.platform
            if not platform:
                continue
            pid = platform.id
            d = r.analysis_date
            raw_commission, raw_cost = _extract_commission_cost(r.result_data)
            commission = api_commission_map.get((pid, d), raw_commission)
            cost = ga_cost_map.get((pid, d), raw_cost)
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

    # 添加未匹配平台的费用行
    for d, unmatched_cost in ga_unmatched_cost_map.items():
        rows.append(ExpenseDailyRow(
            date=d.strftime("%Y-%m-%d"),
            platform_id=-1,  # 使用-1表示未匹配
            platform_name="未匹配",
            commission=0.0,
            ad_cost=round(unmatched_cost, 4),
            rejected_commission=0.0,
            net_profit=round(-unmatched_cost, 4),
        ))
    
    # 排序：日期 desc, 平台 asc
    rows.sort(key=lambda x: (x.date, x.platform_id), reverse=True)
    return ExpenseDailyResponse(
        start_date=start.strftime("%Y-%m-%d"),
        end_date=end.strftime("%Y-%m-%d"),
        rows=rows,
    )


