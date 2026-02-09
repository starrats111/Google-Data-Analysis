"""
我的费用 API
从分析结果中按日期/平台聚合佣金与广告费用，并支持录入拒付佣金
"""
from __future__ import annotations

from typing import Optional, Dict, Tuple, List
from datetime import datetime, date

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi import Body
from sqlalchemy.orm import Session
from sqlalchemy import func, case

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.analysis_result import AnalysisResult
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.platform_data import PlatformData
from app.models.google_ads_api_data import GoogleAdsApiData
from app.models.expense_adjustment import ExpenseAdjustment
from app.models.mcc_cost_adjustment import MccCostAdjustment
from app.models.google_ads_api_data import GoogleMccAccount
from app.schemas.expenses import (
    ExpenseSummaryResponse,
    ExpenseTotals,
    ExpensePlatformSummary,
    ExpenseAdjustmentUpsert,
    ExpenseDailyResponse,
    ExpenseDailyRow,
    ExpenseManagerSummaryResponse,
    ExpenseUserSummary,
    MccCostAdjustmentUpsert,
)
from pydantic import BaseModel

router = APIRouter(prefix="/api/expenses", tags=["expenses"])


def _infer_platform_code_from_campaign_name(campaign_name: str) -> Optional[str]:
    """兜底：从广告系列名推断平台码，支持 001-LB1-xxx / 001_LB1_xxx / 001-LB-xxx"""
    import re
    if not campaign_name:
        return None
    m = re.match(r"^\d+[_-]([A-Za-z]{2,3})\d*[_-]", campaign_name)
    return m.group(1).upper() if m else None

class CleanDuplicateCostsPayload(BaseModel):
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    platform_id: Optional[int] = None
    include_mcc: bool = True  # 同时清理“上传MCC费用”产生的手动费用


@router.get("/cost-detail")
async def get_cost_detail(
    start_date: str,
    end_date: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    获取广告费用详情
    返回每个MCC账号的费用和每个平台的费用
    """
    from app.models.google_ads_api_data import GoogleAdsApiData, GoogleMccAccount
    from app.models.affiliate_account import AffiliatePlatform
    
    start = _parse_date(start_date)
    end = _parse_date(end_date)
    
    # 获取所有平台
    platforms = db.query(AffiliatePlatform).all()
    platform_code_map = {p.platform_code: p for p in platforms}
    
    # 获取手动上传的MCC费用
    mcc_manual_costs = db.query(MccCostAdjustment).filter(
        MccCostAdjustment.user_id == current_user.id,
        MccCostAdjustment.date >= start,
        MccCostAdjustment.date <= end
    ).all()
    mcc_manual_cost_map: Dict[Tuple[int, date], float] = {}
    for adj in mcc_manual_costs:
        mcc_manual_cost_map[(adj.mcc_id, adj.date)] = float(adj.manual_cost or 0.0)
    
    # 按MCC账号汇总费用（包含手动上传的费用）
    # 注意：手动上传可能发生在“该区间没有任何API数据”的MCC上，也需要展示出来
    from sqlalchemy import and_
    
    # 货币转换配置
    CNY_TO_USD_RATE = 7.2
    
    mcc_results = db.query(
        GoogleMccAccount.id,
        GoogleMccAccount.mcc_name,
        GoogleMccAccount.email,
        GoogleMccAccount.currency,
        func.coalesce(func.sum(GoogleAdsApiData.cost), 0.0).label("api_cost"),
    ).outerjoin(
        GoogleAdsApiData,
        and_(
            GoogleAdsApiData.mcc_id == GoogleMccAccount.id,
            GoogleAdsApiData.date >= start,
            GoogleAdsApiData.date <= end,
        ),
    ).filter(
        GoogleMccAccount.user_id == current_user.id,
    ).group_by(
        GoogleMccAccount.id,
        GoogleMccAccount.mcc_name,
        GoogleMccAccount.email,
        GoogleMccAccount.currency,
    ).all()
    
    mcc_breakdown = []
    for r in mcc_results:
        # 计算该MCC的手动费用总和
        manual_cost_total = sum(
            cost for (mcc_id, d), cost in mcc_manual_cost_map.items()
            if mcc_id == r.id and start <= d <= end
        )
        api_cost = float(r.api_cost or 0.0)
        
        # 货币转换：CNY → USD
        mcc_currency = getattr(r, 'currency', 'USD') or 'USD'
        if mcc_currency == 'CNY':
            api_cost = api_cost / CNY_TO_USD_RATE
        
        # 如果存在手动费用，优先使用手动费用；否则使用API费用
        total_cost = manual_cost_total if manual_cost_total > 0 else api_cost

        # 没有任何数据则跳过（避免列表太长）
        if api_cost == 0 and manual_cost_total == 0:
            continue
        
        mcc_breakdown.append({
            "mcc_id": r.id,
            "mcc_name": r.mcc_name,
            "email": r.email,
            "api_cost": round(api_cost, 2),
            "manual_cost": round(manual_cost_total, 2),
            "total_cost": round(total_cost, 2)
        })
    
    # 构建MCC货币映射
    mcc_currency_map = {}
    for mcc in db.query(GoogleMccAccount).filter(GoogleMccAccount.user_id == current_user.id).all():
        mcc_currency_map[mcc.id] = getattr(mcc, 'currency', 'USD') or 'USD'
    
    # 按平台+MCC汇总费用（需要区分货币）
    platform_query = db.query(
        GoogleAdsApiData.extracted_platform_code,
        GoogleAdsApiData.mcc_id,
        func.sum(GoogleAdsApiData.cost).label('total_cost')
    ).filter(
        GoogleAdsApiData.user_id == current_user.id,
        GoogleAdsApiData.date >= start,
        GoogleAdsApiData.date <= end,
        GoogleAdsApiData.extracted_platform_code.isnot(None)
    ).group_by(
        GoogleAdsApiData.extracted_platform_code,
        GoogleAdsApiData.mcc_id
    )
    
    platform_results = platform_query.all()
    # 按平台聚合（含货币转换）
    platform_cost_map = {}
    for r in platform_results:
        code = r.extracted_platform_code
        cost = float(r.total_cost or 0)
        currency = mcc_currency_map.get(r.mcc_id, 'USD')
        if currency == 'CNY':
            cost = cost / CNY_TO_USD_RATE
        platform_cost_map[code] = platform_cost_map.get(code, 0) + cost
    
    platform_breakdown = []
    for code, cost in platform_cost_map.items():
        platform = platform_code_map.get(code)
        platform_breakdown.append({
            "platform_code": code,
            "platform_name": platform.platform_name if platform else code,
            "total_cost": round(cost, 2)
        })
    
    # 未匹配平台的费用（含货币转换）
    unmatched_query = db.query(
        GoogleAdsApiData.mcc_id,
        func.sum(GoogleAdsApiData.cost).label('total_cost')
    ).filter(
        GoogleAdsApiData.user_id == current_user.id,
        GoogleAdsApiData.date >= start,
        GoogleAdsApiData.date <= end,
        GoogleAdsApiData.extracted_platform_code.is_(None)
    ).group_by(GoogleAdsApiData.mcc_id)
    
    # 未匹配平台的费用不再计入总费用（这些是不需要的数据）
    # unmatched_cost 保留为0，仅用于兼容前端
    unmatched_cost = 0.0
    
    # 总费用 = 仅MCC费用（不含未匹配平台费用）
    total_cost = sum(m.get('total_cost', 0) for m in mcc_breakdown)
    
    # 按平台+日期+MCC明细（细分，含货币转换）
    platform_detail_query = db.query(
        GoogleAdsApiData.extracted_platform_code,
        GoogleAdsApiData.date,
        GoogleAdsApiData.mcc_id,
        func.sum(GoogleAdsApiData.cost).label('total_cost'),
        func.count(GoogleAdsApiData.id).label('campaign_count')
    ).filter(
        GoogleAdsApiData.user_id == current_user.id,
        GoogleAdsApiData.date >= start,
        GoogleAdsApiData.date <= end,
        GoogleAdsApiData.extracted_platform_code.isnot(None)
    ).group_by(
        GoogleAdsApiData.extracted_platform_code,
        GoogleAdsApiData.date,
        GoogleAdsApiData.mcc_id
    ).order_by(
        GoogleAdsApiData.extracted_platform_code,
        GoogleAdsApiData.date.desc()
    )
    
    platform_detail_results = platform_detail_query.all()
    # 按平台+日期聚合（含货币转换）
    detail_agg = {}
    for r in platform_detail_results:
        key = (r.extracted_platform_code, r.date)
        cost = float(r.total_cost or 0)
        currency = mcc_currency_map.get(r.mcc_id, 'USD')
        if currency == 'CNY':
            cost = cost / CNY_TO_USD_RATE
        if key not in detail_agg:
            detail_agg[key] = {"cost": 0.0, "count": 0}
        detail_agg[key]["cost"] += cost
        detail_agg[key]["count"] += int(r.campaign_count or 0)
    
    platform_details = []
    for (code, d), vals in detail_agg.items():
        platform = platform_code_map.get(code)
        platform_details.append({
            "platform_code": code,
            "platform_name": platform.platform_name if platform else code,
            "date": d.isoformat() if isinstance(d, date) else str(d),
            "total_cost": round(vals["cost"], 2),
            "campaign_count": vals["count"]
        })
    
    return {
        "start_date": start_date,
        "end_date": end_date,
        "total_cost": total_cost,
        "mcc_breakdown": mcc_breakdown,
        "platform_breakdown": platform_breakdown,
        "platform_details": platform_details,  # 平台费用明细（按日期细分）
        "unmatched_cost": unmatched_cost
    }


@router.post("/clean-duplicate-costs", status_code=status.HTTP_200_OK)
async def clean_duplicate_costs(
    payload: CleanDuplicateCostsPayload = Body(default=CleanDuplicateCostsPayload()),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    清理重复的费用数据
    
    删除指定日期范围内、指定平台的手动上传费用数据（保留Google Ads API同步的费用）
    用于清理历史遗留的重复数据
    """
    try:
        start_date = payload.start_date
        end_date = payload.end_date
        platform_id = payload.platform_id
        include_mcc = payload.include_mcc

        query = db.query(ExpenseAdjustment).filter(
            ExpenseAdjustment.user_id == current_user.id,
            ExpenseAdjustment.manual_cost != 0  # 清理所有非0的手动费用（包含历史异常值）
        )
        
        if start_date:
            start = _parse_date(start_date)
            query = query.filter(ExpenseAdjustment.date >= start)
        
        if end_date:
            end = _parse_date(end_date)
            query = query.filter(ExpenseAdjustment.date <= end)
        
        if platform_id:
            query = query.filter(ExpenseAdjustment.platform_id == platform_id)
        
        # 获取要删除的记录数
        count = query.count()
        
        # 另外：清理“上传MCC费用”写入的数据（会被分摊到平台费用里，导致你觉得RW等平台费用删不掉）
        mcc_deleted_count = 0
        if include_mcc:
            mcc_q = db.query(MccCostAdjustment).filter(
                MccCostAdjustment.user_id == current_user.id,
                MccCostAdjustment.manual_cost != 0,
            )
            if start_date:
                mcc_q = mcc_q.filter(MccCostAdjustment.date >= _parse_date(start_date))
            if end_date:
                mcc_q = mcc_q.filter(MccCostAdjustment.date <= _parse_date(end_date))
            # MCC手动费用与平台无直接对应关系，这里不按platform_id过滤
            mcc_deleted_count = mcc_q.count()
            for adj in mcc_q.all():
                db.delete(adj)
        
        if count == 0 and mcc_deleted_count == 0:
            return {"message": "没有找到需要清理的手动费用数据", "deleted_count": 0, "mcc_deleted_count": 0}
        
        # 真正删除有手动费用的记录（如果该行没有其它手动字段，则删除整行；否则只清空manual_cost）
        deleted_count = 0
        for adj in query.all():
            if float(adj.rejected_commission or 0) == 0 and float(adj.manual_commission or 0) == 0:
                # 没有拒付佣金/手动佣金，删除整个记录
                db.delete(adj)
                deleted_count += 1
            else:
                # 还有其它数据，只清空manual_cost
                adj.manual_cost = 0.0
        
        db.commit()
        
        msg = f"成功清理平台手动费用记录 {deleted_count} 条"
        if include_mcc:
            msg += f"，清理MCC手动费用 {mcc_deleted_count} 条"
        msg += "（保留Google Ads API同步的费用）"
        return {"message": msg, "deleted_count": deleted_count, "mcc_deleted_count": mcc_deleted_count}
        
    except Exception as e:
        db.rollback()
        import logging
        logger = logging.getLogger(__name__)
        logger.error(f"清理重复费用数据失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"清理失败: {str(e)}")


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


def _build_ga_cost_maps(
    *,
    db: Session,
    user_id: int,
    start: date,
    end: date,
    platform_code_map: Dict[str, int],
    mcc_manual_cost_map: Dict[Tuple[int, date], float],
) -> Tuple[Dict[Tuple[int, date], float], Dict[date, float], set, float]:
    """
    构建 Google Ads API 广告费用映射（按 platform_id + date 汇总），并返回未匹配平台的费用（按 date 汇总）。

    返回值:
    - ga_cost_map: (platform_id, date) -> cost (匹配到平台的费用)
    - ga_unmatched_cost_map: date -> cost (未匹配平台的费用，但不再使用)
    - day_set: 出现的日期集合
    - mcc_total_cost: 所有MCC的总费用（用于显示"总广告费用"）

    关键点：
    - 先在数据库里按 (mcc_id, date, extracted_platform_code) 聚合，避免拉取明细导致慢/内存大
    - MCC 手动费用是"按 MCC + 日期"覆盖总费用，不能在明细循环中重复累加
    - 自动进行CNY→USD货币转换
    """
    from app.models.google_ads_api_data import GoogleAdsApiData

    # 获取MCC货币映射，用于CNY→USD转换
    CNY_TO_USD_RATE = 7.2
    mcc_currency_map: Dict[int, str] = {}
    for mcc in db.query(GoogleMccAccount).filter(GoogleMccAccount.user_id == user_id).all():
        mcc_currency_map[mcc.id] = getattr(mcc, 'currency', 'USD') or 'USD'

    # (mcc_id, date, platform_code) -> api_cost_sum
    api_cost_by_mcc_date_code: Dict[Tuple[int, date, Optional[str]], float] = {}
    # (mcc_id, date) -> api_total_cost_sum
    api_total_by_mcc_date: Dict[Tuple[int, date], float] = {}
    day_set: set = set()

    ga_agg_rows = db.query(
        GoogleAdsApiData.mcc_id,
        GoogleAdsApiData.date,
        GoogleAdsApiData.extracted_platform_code,
        GoogleAdsApiData.campaign_name,
        func.coalesce(func.sum(GoogleAdsApiData.cost), 0.0).label("cost_sum"),
    ).filter(
        GoogleAdsApiData.user_id == user_id,
        GoogleAdsApiData.date >= start,
        GoogleAdsApiData.date <= end,
    ).group_by(
        GoogleAdsApiData.mcc_id,
        GoogleAdsApiData.date,
        GoogleAdsApiData.extracted_platform_code,
    ).all()

    for r in ga_agg_rows:
        mcc_id = int(r.mcc_id) if r.mcc_id is not None else None
        d = r.date
        if mcc_id is None or not isinstance(d, date):
            continue
        platform_code = r.extracted_platform_code  # may be None
        if not platform_code:
            platform_code = _infer_platform_code_from_campaign_name(getattr(r, "campaign_name", "") or "")
        cost_sum = float(r.cost_sum or 0.0)
        # CNY→USD货币转换
        currency = mcc_currency_map.get(mcc_id, 'USD')
        if currency == 'CNY':
            cost_sum = cost_sum / CNY_TO_USD_RATE
        day_set.add(d)
        api_cost_by_mcc_date_code[(mcc_id, d, platform_code)] = cost_sum
        api_total_by_mcc_date[(mcc_id, d)] = api_total_by_mcc_date.get((mcc_id, d), 0.0) + cost_sum

    # 输出
    ga_cost_map: Dict[Tuple[int, date], float] = {}         # (platform_id, date) -> cost
    ga_unmatched_cost_map: Dict[date, float] = {}           # date -> cost (不再使用，保留兼容)
    mcc_total_cost: float = 0.0                              # MCC总费用

    # 处理所有出现过的 (mcc_id, date)
    all_mcc_dates = set(api_total_by_mcc_date.keys()) | set(mcc_manual_cost_map.keys())

    for mcc_key in all_mcc_dates:
        mcc_id, d = mcc_key
        day_set.add(d)
        manual_cost = mcc_manual_cost_map.get(mcc_key, None)
        api_total = api_total_by_mcc_date.get(mcc_key, 0.0)

        # 计算该MCC当天的实际费用（用于总费用统计）
        if manual_cost is not None:
            mcc_total_cost += float(manual_cost or 0.0)
        else:
            mcc_total_cost += api_total

        # 取出该 mcc/date 下所有 platform_code 的 api 成本（含 None）
        code_cost_pairs = [
            (code, api_cost_by_mcc_date_code.get((mcc_id, d, code), 0.0))
            for (mid, dd, code) in api_cost_by_mcc_date_code.keys()
            if mid == mcc_id and dd == d
        ]
        # 去重并过滤 0，避免无意义分配
        tmp: Dict[Optional[str], float] = {}
        for code, v in code_cost_pairs:
            tmp[code] = tmp.get(code, 0.0) + float(v or 0.0)
        code_cost_pairs = [(c, v) for c, v in tmp.items() if float(v or 0.0) != 0.0]

        if manual_cost is not None:
            manual_cost = float(manual_cost or 0.0)
            if api_total > 0 and code_cost_pairs:
                # 有 API 结构，用比例分配手动费用到各 platform_code（含 None -> 未匹配）
                for code, api_cost in code_cost_pairs:
                    ratio = float(api_cost) / float(api_total)
                    allocated = manual_cost * ratio
                    if code:
                        pid = platform_code_map.get(code)
                        if pid:
                            ga_cost_map[(pid, d)] = ga_cost_map.get((pid, d), 0.0) + allocated
                        else:
                            ga_unmatched_cost_map[d] = ga_unmatched_cost_map.get(d, 0.0) + allocated
                    else:
                        ga_unmatched_cost_map[d] = ga_unmatched_cost_map.get(d, 0.0) + allocated
            else:
                # 没有任何 API 数据可用于分配：全部计入未匹配（与旧逻辑实际效果一致）
                ga_unmatched_cost_map[d] = ga_unmatched_cost_map.get(d, 0.0) + manual_cost
        else:
            # 没有手动费用：直接用 API 聚合费用
            if not code_cost_pairs:
                continue
            for code, api_cost in code_cost_pairs:
                if code:
                    pid = platform_code_map.get(code)
                    if pid:
                        ga_cost_map[(pid, d)] = ga_cost_map.get((pid, d), 0.0) + float(api_cost or 0.0)
                    else:
                        ga_unmatched_cost_map[d] = ga_unmatched_cost_map.get(d, 0.0) + float(api_cost or 0.0)
                else:
                    ga_unmatched_cost_map[d] = ga_unmatched_cost_map.get(d, 0.0) + float(api_cost or 0.0)

    return ga_cost_map, ga_unmatched_cost_map, day_set, mcc_total_cost


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
    """录入/更新某平台某日的拒付佣金、手动费用和手动佣金"""
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
            manual_cost=float(payload.manual_cost or 0.0) if payload.manual_cost is not None else 0.0,
            manual_commission=float(payload.manual_commission or 0.0) if payload.manual_commission is not None else 0.0,
        )
        db.add(adj)
    else:
        adj.rejected_commission = float(payload.rejected_commission or 0.0)
        if payload.manual_cost is not None:
            adj.manual_cost = float(payload.manual_cost or 0.0)
        if payload.manual_commission is not None:
            adj.manual_commission = float(payload.manual_commission or 0.0)

    db.commit()
    return {"message": "保存成功"}


@router.post("/mcc-cost", status_code=status.HTTP_200_OK)
async def upsert_mcc_cost(
    payload: MccCostAdjustmentUpsert,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """录入/更新某MCC某日的手动费用"""
    d = _parse_date(payload.date)
    mcc = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.id == payload.mcc_id,
        GoogleMccAccount.user_id == current_user.id
    ).first()
    if not mcc:
        raise HTTPException(status_code=404, detail="MCC账号不存在")

    adj = db.query(MccCostAdjustment).filter(
        MccCostAdjustment.user_id == current_user.id,
        MccCostAdjustment.mcc_id == payload.mcc_id,
        MccCostAdjustment.date == d,
    ).first()
    if not adj:
        adj = MccCostAdjustment(
            user_id=current_user.id,
            mcc_id=payload.mcc_id,
            date=d,
            manual_cost=float(payload.manual_cost or 0.0),
        )
        db.add(adj)
    else:
        adj.manual_cost = float(payload.manual_cost or 0.0)

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
    platform_code_map = {p.platform_code: p.id for p in platform_rows}
    
    # 所有员工的总计
    all_total_commission = 0.0
    all_total_cost = 0.0
    all_total_mcc_cost = 0.0  # MCC实际总费用
    all_total_rejected = 0.0
    all_day_set = set()
    
    # 按员工汇总
    user_summaries: List[ExpenseUserSummary] = []
    
    for employee in employees:
        # 获取该员工的 MCC 手动费用调整
        mcc_manual_costs = db.query(MccCostAdjustment).filter(
            MccCostAdjustment.user_id == employee.id,
            MccCostAdjustment.date >= start,
            MccCostAdjustment.date <= end
        ).all()
        mcc_manual_cost_map: Dict[Tuple[int, date], float] = {}
        for adj in mcc_manual_costs:
            mcc_manual_cost_map[(adj.mcc_id, adj.date)] = float(adj.manual_cost or 0.0)
        
        # 获取该员工的 MCC 总费用
        _, _, _, user_mcc_total_cost = _build_ga_cost_maps(
            db=db,
            user_id=employee.id,
            start=start,
            end=end,
            platform_code_map=platform_code_map,
            mcc_manual_cost_map=mcc_manual_cost_map,
        )
        
        # 获取该员工的每日指标（先按平台/日期聚合，避免 N+1 + 全量拉取）
        metric_rows = db.query(
            AdCampaign.platform_id.label("platform_id"),
            AdCampaignDailyMetric.date.label("d"),
            func.coalesce(func.sum(AdCampaignDailyMetric.commission), 0.0).label("commission_sum"),
            func.coalesce(func.sum(AdCampaignDailyMetric.cost), 0.0).label("cost_sum"),
        ).join(
            AdCampaign, AdCampaign.id == AdCampaignDailyMetric.campaign_id
        ).filter(
            AdCampaignDailyMetric.user_id == employee.id,
            AdCampaignDailyMetric.date >= start,
            AdCampaignDailyMetric.date <= end,
            AdCampaign.platform_id.isnot(None),
        ).group_by(
            AdCampaign.platform_id,
            AdCampaignDailyMetric.date,
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
        
        for r in metric_rows:
            pid = int(r.platform_id) if r.platform_id is not None else None
            d = r.d
            if pid is None or not isinstance(d, date):
                continue
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
            by_date[d][0] += float(r.commission_sum or 0.0)
            by_date[d][1] += float(r.cost_sum or 0.0)
        
        # 如果没有每日指标，尝试从分析结果获取
        if not metric_rows:
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
                today_paid_commission=round(today_commission, 4),
                today_ad_cost=round(today_cost, 4),
                today_rejected_commission=round(today_rejected, 4),
                today_net_profit=round(today_net, 4),
                range_commission=round(range_commission, 4),
                range_paid_commission=round(range_commission, 4),
                range_ad_cost=round(range_cost, 4),
                range_rejected_commission=round(range_rejected, 4),
                range_net_profit=round(range_net, 4),
            ))
        
        all_total_commission += user_total_commission
        all_total_cost += user_total_cost
        all_total_mcc_cost += user_mcc_total_cost
        all_total_rejected += user_total_rejected
        
        # 员工的总广告费用使用MCC实际费用（如果有的话）
        user_display_cost = user_mcc_total_cost if user_mcc_total_cost > 0 else user_total_cost
        user_summaries.append(ExpenseUserSummary(
            user_id=employee.id,
            username=employee.username,
            total_commission=round(user_total_commission, 4),
            total_ad_cost=round(user_display_cost, 4),
            total_rejected_commission=round(user_total_rejected, 4),
            net_profit=round(user_total_commission - user_total_rejected - user_display_cost, 4),
            platforms=user_platforms,
        ))
    
    # 计算总计（使用MCC实际总费用）
    all_display_cost = all_total_mcc_cost if all_total_mcc_cost > 0 else all_total_cost
    day_count = len(all_day_set) if len(all_day_set) > 0 else 0
    net_profit = all_total_commission - all_total_rejected - all_display_cost
    avg_daily = (net_profit / day_count) if day_count > 0 else 0.0
    
    totals = ExpenseTotals(
        total_commission=round(all_total_commission, 4),
        total_ad_cost=round(all_display_cost, 4),
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


@router.get("/by-user/{user_id}")
async def get_expense_by_user(
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取指定用户的费用汇总（经理专用）"""
    from datetime import timedelta
    from app.config import settings
    
    if current_user.role != "manager":
        raise HTTPException(status_code=403, detail="只有经理可以查看其他用户的费用")
    
    CNY_TO_USD_RATE = float(getattr(settings, "CNY_TO_USD_RATE", 7.2) or 7.2)
    today = date.today()
    
    # 本月
    month_start = today.replace(day=1)
    month_end = today - timedelta(days=1)
    
    # 本季度
    quarter_month = ((today.month - 1) // 3) * 3 + 1
    quarter_start = today.replace(month=quarter_month, day=1)
    
    # 本年度
    year_start = today.replace(month=1, day=1)
    
    # 获取用户的MCC货币映射
    mcc_accounts = db.query(GoogleMccAccount).filter(GoogleMccAccount.user_id == user_id).all()
    mcc_currency_map = {mcc.id: getattr(mcc, 'currency', 'USD') or 'USD' for mcc in mcc_accounts}
    
    def get_period_stats(start_dt: date, end_dt: date):
        # 费用
        cost_rows = db.query(
            GoogleAdsApiData.mcc_id,
            func.sum(GoogleAdsApiData.cost).label('cost')
        ).filter(
            GoogleAdsApiData.user_id == user_id,
            GoogleAdsApiData.date >= start_dt,
            GoogleAdsApiData.date <= end_dt,
        ).group_by(GoogleAdsApiData.mcc_id).all()
        
        total_cost = 0.0
        for row in cost_rows:
            cost = float(row.cost or 0)
            currency = mcc_currency_map.get(row.mcc_id, 'USD')
            if currency == 'CNY':
                cost = cost / CNY_TO_USD_RATE
            total_cost += cost
        
        # 佣金
        from app.models.affiliate_transaction import AffiliateTransaction
        commission = db.query(
            func.sum(AffiliateTransaction.commission_amount)
        ).filter(
            AffiliateTransaction.user_id == user_id,
            func.date(AffiliateTransaction.transaction_time) >= start_dt,
            func.date(AffiliateTransaction.transaction_time) <= end_dt,
        ).scalar() or 0
        
        return total_cost, float(commission)
    
    cost_month, commission_month = get_period_stats(month_start, month_end)
    cost_quarter, commission_quarter = get_period_stats(quarter_start, today - timedelta(days=1))
    cost_year, commission_year = get_period_stats(year_start, today - timedelta(days=1))
    
    roi_month = commission_month / cost_month if cost_month > 0 else 0
    
    return {
        "cost_month": cost_month,
        "commission_month": commission_month,
        "roi_month": roi_month,
        "cost_quarter": cost_quarter,
        "commission_quarter": commission_quarter,
        "cost_year": cost_year,
        "commission_year": commission_year,
    }


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
    # 容错：前端允许选择“某一天”，可能会选到区间之外（例如 today_date > end_date）
    # 统一将 today 夹在 [start, end] 之间，避免后续逻辑出现空键/异常导致500
    if today < start:
        today = start
    elif today > end:
        today = end

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

    # ===== 计算“已付/通过佣金(approved)” 与 “拒付佣金(rejected)”（来自明细交易）=====
    # 说明：PlatformData.commission 现在是“所有状态”的总佣金；这里补充明细维度的 approved/rejected 佣金，
    # 用于在表格中展示“已付佣金/拒付佣金”。
    approved_comm_map: Dict[Tuple[int, date], float] = {}
    rejected_comm_map: Dict[Tuple[int, date], float] = {}
    try:
        from app.models.affiliate_transaction import AffiliateTransaction
        begin_dt = datetime.combine(start, datetime.min.time())
        end_dt = datetime.combine(end, datetime.max.time())
        total_comm_map: Dict[Tuple[int, date], float] = {}
        tx_rows = db.query(
            AffiliateAccount.platform_id.label("platform_id"),
            func.date(AffiliateTransaction.transaction_time).label("d"),
            func.sum(AffiliateTransaction.commission_amount).label("total_comm"),
            func.sum(
                case(
                    (AffiliateTransaction.status == "approved", AffiliateTransaction.commission_amount),
                    else_=0
                )
            ).label("approved_comm"),
            func.sum(
                case(
                    (AffiliateTransaction.status == "rejected", AffiliateTransaction.commission_amount),
                    else_=0
                )
            ).label("rejected_comm"),
        ).join(
            AffiliateAccount, AffiliateAccount.id == AffiliateTransaction.affiliate_account_id
        ).filter(
            AffiliateTransaction.user_id == current_user.id,
            AffiliateTransaction.transaction_time >= begin_dt,
            AffiliateTransaction.transaction_time <= end_dt,
        ).group_by(
            AffiliateAccount.platform_id,
            func.date(AffiliateTransaction.transaction_time),
        ).all()

        for r in tx_rows:
            pid = int(r.platform_id) if r.platform_id is not None else None
            if pid is None:
                continue
            d_raw = r.d
            if isinstance(d_raw, date):
                d = d_raw
            else:
                d = datetime.strptime(str(d_raw), "%Y-%m-%d").date()
            total_comm_map[(pid, d)] = float(r.total_comm or 0.0)
            approved_comm_map[(pid, d)] = float(r.approved_comm or 0.0)
            rejected_comm_map[(pid, d)] = float(r.rejected_comm or 0.0)
    except Exception:
        # 不因明细统计失败而中断汇总（避免500）
        approved_comm_map = {}
        rejected_comm_map = {}
        total_comm_map = {}

    # (platform_id, date) -> commission_from_api
    api_commission_map: Dict[Tuple[int, date], float] = {}
    # 初始化手动佣金和手动费用映射（在使用前先初始化，避免引用错误）
    manual_commission_map: Dict[Tuple[int, date], float] = {}
    manual_cost_map: Dict[Tuple[int, date], float] = {}
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

    # 兜底：PlatformData 可能为空，使用交易明细按天聚合“所有状态总佣金”
    total_comm_map: Dict[Tuple[int, date], float] = {}
    try:
        from app.models.affiliate_transaction import AffiliateTransaction
        begin_dt = datetime.combine(start, datetime.min.time())
        end_dt = datetime.combine(end, datetime.max.time())
        tx_rows = db.query(
            AffiliateAccount.platform_id.label("platform_id"),
            func.date(AffiliateTransaction.transaction_time).label("d"),
            func.sum(AffiliateTransaction.commission_amount).label("total_comm"),
        ).join(
            AffiliateAccount, AffiliateAccount.id == AffiliateTransaction.affiliate_account_id
        ).filter(
            AffiliateTransaction.user_id == current_user.id,
            AffiliateTransaction.transaction_time >= begin_dt,
            AffiliateTransaction.transaction_time <= end_dt,
        ).group_by(
            AffiliateAccount.platform_id,
            func.date(AffiliateTransaction.transaction_time),
        ).all()
        for r in tx_rows:
            pid = int(r.platform_id) if r.platform_id is not None else None
            if pid is None:
                continue
            d_raw = r.d
            if isinstance(d_raw, date):
                d = d_raw
            else:
                d = datetime.strptime(str(d_raw), "%Y-%m-%d").date()
            total_comm_map[(pid, d)] = float(r.total_comm or 0.0)
    except Exception:
        total_comm_map = {}

    for (pid, d), comm in total_comm_map.items():
        if (pid, d) not in api_commission_map:
            api_commission_map[(pid, d)] = float(comm or 0.0)
        day_set.add(pd.date)

    # 兜底：若 PlatformData 未覆盖到的日期/平台，用交易明细的“所有状态总佣金”补齐
    for (pid, d), comm in total_comm_map.items():
        if (pid, d) not in api_commission_map:
            api_commission_map[(pid, d)] = float(comm or 0.0)
            day_set.add(d)

    # 获取手动上传的MCC费用
    mcc_manual_costs = db.query(MccCostAdjustment).filter(
        MccCostAdjustment.user_id == current_user.id,
        MccCostAdjustment.date >= start,
        MccCostAdjustment.date <= end
    ).all()
    mcc_manual_cost_map: Dict[Tuple[int, date], float] = {}  # (mcc_id, date) -> manual_cost
    for adj in mcc_manual_costs:
        mcc_manual_cost_map[(adj.mcc_id, adj.date)] = float(adj.manual_cost or 0.0)
    
    # ===== 从 Google Ads API 数据中统计"广告费用"（聚合后再计算，避免全量拉取与重复累加）=====
    ga_cost_map, ga_unmatched_cost_map, ga_day_set, mcc_total_cost = _build_ga_cost_maps(
        db=db,
        user_id=current_user.id,
        start=start,
        end=end,
        platform_code_map=platform_code_map,
        mcc_manual_cost_map=mcc_manual_cost_map,
    )
    day_set.update(ga_day_set)

    # 1) 从每日指标聚合（仅作为费用的补充/兜底，优先使用Google Ads API）
    metric_cost_rows = db.query(
        AdCampaign.platform_id.label("platform_id"),
        AdCampaignDailyMetric.date.label("d"),
        func.coalesce(func.sum(AdCampaignDailyMetric.cost), 0.0).label("cost_sum"),
    ).join(
        AdCampaign, AdCampaign.id == AdCampaignDailyMetric.campaign_id
    ).filter(
        AdCampaignDailyMetric.user_id == current_user.id,
        AdCampaignDailyMetric.date >= start,
        AdCampaignDailyMetric.date <= end,
        AdCampaign.platform_id.isnot(None),
    ).group_by(
        AdCampaign.platform_id,
        AdCampaignDailyMetric.date,
    ).all()

    if metric_cost_rows:
        for r in metric_cost_rows:
            pid = int(r.platform_id) if r.platform_id is not None else None
            d = r.d
            if pid is None or not isinstance(d, date):
                continue
            day_set.add(d)
            if pid not in platform_map:
                platform_map[pid] = {
                    "platform_id": pid,
                    "platform_name": platform_name_map.get(pid, f"平台{pid}"),
                    "by_date": {},
                }
            by_date = platform_map[pid]["by_date"]
            if d not in by_date:
                by_date[d] = [0.0, 0.0]
            # 费用来自每日指标（仅在该天该平台没有 Google Ads 数据时作为兜底；后续会被 ga_cost_map 覆盖）
            by_date[d][1] += float(r.cost_sum or 0.0)
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
    # 但如果存在手动佣金，则优先使用手动佣金
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
        # 如果存在手动佣金，优先使用手动佣金；否则使用API佣金
        manual_comm = manual_commission_map.get((pid, d), None)
        if manual_comm is not None:
            by_date[d][0] = manual_comm  # 使用手动佣金
        else:
            by_date[d][0] = api_comm  # 使用API佣金

    # 使用 Google Ads API 中的费用覆盖旧逻辑的费用（广告费用直接来自Google Ads）
    # 但如果存在手动费用，则优先使用手动费用
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
        # 如果存在手动费用，优先使用手动费用；否则使用Google Ads API费用
        manual_cost = manual_cost_map.get((pid, d), None)
        if manual_cost is not None:
            by_date[d][1] = manual_cost  # 使用手动费用
        else:
            by_date[d][1] = ga_cost  # 使用Google Ads API费用
    
    # 未匹配平台的费用不再计入（这些是不需要的数据）
    # for d, unmatched_cost in ga_unmatched_cost_map.items():
    #     day_set.add(d)

    # 拉取拒付佣金调整、手动费用和手动佣金（区间内）
    adjustments = db.query(ExpenseAdjustment).filter(
        ExpenseAdjustment.user_id == current_user.id,
        ExpenseAdjustment.date >= start,
        ExpenseAdjustment.date <= end,
    ).all()
    adj_map: Dict[Tuple[int, date], float] = {}  # (platform_id, date) -> rejected_commission
    # manual_cost_map 和 manual_commission_map 已在上面初始化，这里只需要填充数据
    for a in adjustments:
        adj_map[(a.platform_id, a.date)] = float(a.rejected_commission or 0.0)
        if a.manual_cost and a.manual_cost > 0:
            manual_cost_map[(a.platform_id, a.date)] = float(a.manual_cost or 0.0)
        if a.manual_commission and a.manual_commission > 0:
            manual_commission_map[(a.platform_id, a.date)] = float(a.manual_commission or 0.0)

    # 组装平台汇总
    platforms: List[ExpensePlatformSummary] = []
    total_commission = 0.0
    total_cost = 0.0
    total_rejected = 0.0
    total_paid = 0.0

    for pid, info in sorted(platform_map.items(), key=lambda kv: kv[0]):
        by_date = info["by_date"]

        # 当天
        today_commission = 0.0
        today_paid_commission = 0.0
        today_cost = 0.0
        if today in by_date:
            today_commission, today_cost = by_date[today][0], by_date[today][1]
        # 已付/通过佣金（approved）
        if (pid, today) in approved_comm_map:
            today_paid_commission = approved_comm_map.get((pid, today), 0.0)
        # 手动佣金：若当天有手动佣金，认为这是“已付佣金/总佣金”的覆盖值
        today_manual_comm = manual_commission_map.get((pid, today), None)
        if today_manual_comm is not None:
            today_commission = today_manual_comm
            today_paid_commission = today_manual_comm
        # 如果当天有手动费用，使用手动费用
        today_manual_cost = manual_cost_map.get((pid, today), None)
        if today_manual_cost is not None:
            today_cost = today_manual_cost
        # 拒付佣金：交易拒付 + 手动拒付调整
        today_rejected = rejected_comm_map.get((pid, today), 0.0) + adj_map.get((pid, today), 0.0)
        today_net = today_commission - today_rejected - today_cost

        # 区间累计
        range_commission = sum(v[0] for v in by_date.values())
        range_cost = sum(v[1] for v in by_date.values())
        range_paid_commission = 0.0
        # 对于有手动费用的日期，使用手动费用覆盖
        for d in by_date.keys():
            manual_cost = manual_cost_map.get((pid, d), None)
            if manual_cost is not None:
                range_cost -= by_date[d][1]  # 减去原费用
                range_cost += manual_cost  # 加上手动费用
        # 已付/通过佣金：按天累加 approved；若该天有手动佣金，则用手动佣金覆盖当天的已付/总佣金
        for d in by_date.keys():
            manual_comm = manual_commission_map.get((pid, d), None)
            if manual_comm is not None:
                range_paid_commission += manual_comm
            else:
                range_paid_commission += approved_comm_map.get((pid, d), 0.0)

        range_rejected = sum(
            (rejected_comm_map.get((pid, d), 0.0) + adj_map.get((pid, d), 0.0))
            for d in by_date.keys()
        )
        range_net = range_commission - range_rejected - range_cost

        total_commission += range_commission
        total_cost += range_cost
        total_rejected += range_rejected
        total_paid += range_paid_commission

        platforms.append(ExpensePlatformSummary(
            platform_id=pid,
            platform_name=info["platform_name"],
            today_commission=round(today_commission, 4),
            today_paid_commission=round(today_paid_commission, 4),
            today_ad_cost=round(today_cost, 4),
            today_rejected_commission=round(today_rejected, 4),
            today_net_profit=round(today_net, 4),
            range_commission=round(range_commission, 4),
            range_paid_commission=round(range_paid_commission, 4),
            range_ad_cost=round(range_cost, 4),
            range_rejected_commission=round(range_rejected, 4),
            range_net_profit=round(range_net, 4),
        ))

    # 总广告费用使用MCC实际总费用（而非只计算匹配到平台的费用）
    # 这样可以确保"总广告费用"与"MCC费用明细"中的总费用一致
    total_ad_cost = mcc_total_cost if mcc_total_cost > 0 else total_cost
    
    day_count = len(day_set) if len(day_set) > 0 else 0
    net_profit = total_commission - total_rejected - total_ad_cost
    avg_daily = (net_profit / day_count) if day_count > 0 else 0.0

    totals = ExpenseTotals(
        total_commission=round(total_commission, 4),
        total_ad_cost=round(total_ad_cost, 4),
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
    try:
        start = _parse_date(start_date)
        end = _parse_date(end_date)
        if end < start:
            raise HTTPException(status_code=400, detail="结束日期不能早于开始日期")
    except HTTPException:
        raise
    except Exception as e:
        import logging
        logger = logging.getLogger(__name__)
        logger.error(f"解析日期参数失败: {e}", exc_info=True)
        raise HTTPException(status_code=400, detail=f"日期格式错误: {str(e)}")

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

    # 获取手动上传的MCC费用
    mcc_manual_costs = db.query(MccCostAdjustment).filter(
        MccCostAdjustment.user_id == current_user.id,
        MccCostAdjustment.date >= start,
        MccCostAdjustment.date <= end
    ).all()
    mcc_manual_cost_map: Dict[Tuple[int, date], float] = {}
    for adj in mcc_manual_costs:
        mcc_manual_cost_map[(adj.mcc_id, adj.date)] = float(adj.manual_cost or 0.0)
    
    # 从 Google Ads API 统计每日"广告费用"（聚合后再计算，避免全量拉取与重复累加）
    ga_cost_map, ga_unmatched_cost_map, _, _ = _build_ga_cost_maps(
        db=db,
        user_id=current_user.id,
        start=start,
        end=end,
        platform_code_map=platform_code_map,
        mcc_manual_cost_map=mcc_manual_cost_map,
    )

    # 优先：每日指标 -> 按平台/日期汇总广告费用（若某天某平台没有Google Ads数据时作为兜底）
    metric_cost_rows = db.query(
        AdCampaign.platform_id.label("platform_id"),
        AdCampaignDailyMetric.date.label("d"),
        func.coalesce(func.sum(AdCampaignDailyMetric.cost), 0.0).label("cost_sum"),
    ).join(
        AdCampaign, AdCampaign.id == AdCampaignDailyMetric.campaign_id
    ).filter(
        AdCampaignDailyMetric.user_id == current_user.id,
        AdCampaignDailyMetric.date >= start,
        AdCampaignDailyMetric.date <= end,
        AdCampaign.platform_id.isnot(None),
    ).group_by(
        AdCampaign.platform_id,
        AdCampaignDailyMetric.date,
    ).all()

    adjustments = db.query(ExpenseAdjustment).filter(
        ExpenseAdjustment.user_id == current_user.id,
        ExpenseAdjustment.date >= start,
        ExpenseAdjustment.date <= end,
    ).all()
    adj_map: Dict[Tuple[int, date], float] = {(a.platform_id, a.date): float(a.rejected_commission or 0.0) for a in adjustments}
    manual_cost_map: Dict[Tuple[int, date], float] = {}
    manual_commission_map: Dict[Tuple[int, date], float] = {}
    for a in adjustments:
        if a.manual_cost and a.manual_cost > 0:
            manual_cost_map[(a.platform_id, a.date)] = float(a.manual_cost or 0.0)
        if a.manual_commission and a.manual_commission > 0:
            manual_commission_map[(a.platform_id, a.date)] = float(a.manual_commission or 0.0)

    rows: List[ExpenseDailyRow] = []
    if metric_cost_rows:
        # 聚合 (pid, date) -> [commission, cost]，其中佣金稍后由PlatformData覆盖
        agg: Dict[Tuple[int, date], List[float]] = {}
        for r in metric_cost_rows:
            try:
                pid = int(r.platform_id) if r.platform_id is not None else None
                d = r.d
                if pid is None or not isinstance(d, date):
                    continue
                key = (pid, d)
                if key not in agg:
                    agg[key] = [0.0, 0.0]
                agg[key][1] += float(r.cost_sum or 0.0)
            except Exception as e:
                import logging
                logger = logging.getLogger(__name__)
                logger.warning(f"处理指标聚合数据时出错: {e}", exc_info=True)
                continue

        for (pid, d), (commission_cost) in agg.items():
            try:
                # 优先使用手动佣金，其次使用API佣金
                manual_comm = manual_commission_map.get((pid, d), None)
                if manual_comm is not None:
                    commission = manual_comm
                else:
                    commission = api_commission_map.get((pid, d), 0.0)
                # 优先使用手动费用，其次使用Google Ads API的费用，最后使用每日指标的费用
                manual_cost = manual_cost_map.get((pid, d), None)
                if manual_cost is not None:
                    cost = manual_cost
                else:
                    cost = ga_cost_map.get((pid, d), commission_cost[1] if commission_cost else 0.0)
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
            except Exception as e:
                import logging
                logger = logging.getLogger(__name__)
                logger.warning(f"处理平台数据时出错 (pid={pid}, date={d}): {e}", exc_info=True)
                continue
    else:
        # 兼容旧逻辑：从分析结果聚合
        try:
            results = db.query(AnalysisResult).join(AffiliateAccount).join(AffiliatePlatform).filter(
                AnalysisResult.user_id == current_user.id,
                AnalysisResult.analysis_date >= start,
                AnalysisResult.analysis_date <= end,
            ).all()

            for r in results:
                try:
                    platform = r.affiliate_account.platform
                    if not platform:
                        continue
                    pid = platform.id
                    if pid is None:
                        continue
                    d = r.analysis_date
                    raw_commission, raw_cost = _extract_commission_cost(r.result_data)
                    # 优先使用手动佣金，其次使用API佣金
                    manual_comm = manual_commission_map.get((pid, d), None)
                    if manual_comm is not None:
                        commission = manual_comm
                    else:
                        commission = api_commission_map.get((pid, d), raw_commission)
                    # 优先使用手动费用，其次使用Google Ads API的费用，最后使用分析结果的费用
                    manual_cost = manual_cost_map.get((pid, d), None)
                    if manual_cost is not None:
                        cost = manual_cost
                    else:
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
                except Exception as e:
                    import logging
                    logger = logging.getLogger(__name__)
                    logger.warning(f"处理分析结果时出错: {e}", exc_info=True)
                    continue
        except Exception as e:
            import logging
            logger = logging.getLogger(__name__)
            logger.error(f"查询分析结果失败: {e}", exc_info=True)
            # 继续执行，返回空列表而不是崩溃

    # 未匹配平台的费用不再显示（这些是不需要的数据）
    # for d, unmatched_cost in ga_unmatched_cost_map.items():
    #     rows.append(ExpenseDailyRow(...))
    
    # 排序：日期 desc, 平台 asc
    rows.sort(key=lambda x: (x.date, x.platform_id), reverse=True)
    return ExpenseDailyResponse(
        start_date=start.strftime("%Y-%m-%d"),
        end_date=end.strftime("%Y-%m-%d"),
        rows=rows,
    )


