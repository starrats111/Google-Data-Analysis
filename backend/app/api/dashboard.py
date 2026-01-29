"""
数据总览API

- 经理：全站概览、员工列表等
- 员工：个人概览（Top/Bottom 广告系列 + 趋势）
"""
from typing import List, Optional, Dict, Any
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import date, timedelta

from app.database import get_db
from app.middleware.auth import get_current_manager, get_current_user
from app.models.user import User, UserRole
from app.models.analysis_result import AnalysisResult
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.data_upload import DataUpload
from app.config import settings

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


@router.get("/overview")
async def get_overview(
    current_user: User = Depends(get_current_manager),
    db: Session = Depends(get_db)
):
    """获取总览数据"""
    # 总上传数
    total_uploads = db.query(DataUpload).count()
    
    # 总分析数
    total_analyses = db.query(AnalysisResult).count()
    
    # 活跃员工数
    active_employees = db.query(func.distinct(AnalysisResult.user_id)).count()
    
    # 今日上传数
    from datetime import date
    today_uploads = db.query(DataUpload).filter(
        func.date(DataUpload.uploaded_at) == date.today()
    ).count()
    
    return {
        "total_uploads": total_uploads,
        "total_analyses": total_analyses,
        "active_employees": active_employees,
        "today_uploads": today_uploads
    }


@router.get("/employees")
async def get_employees_data(
    current_user: User = Depends(get_current_manager),
    db: Session = Depends(get_db)
):
    """获取所有员工数据"""
    employees = db.query(User).filter(User.role == UserRole.EMPLOYEE).all()
    
    result = []
    for employee in employees:
        # 统计该员工的数据
        upload_count = db.query(DataUpload).filter(
            DataUpload.user_id == employee.id
        ).count()
        
        analysis_count = db.query(AnalysisResult).filter(
            AnalysisResult.user_id == employee.id
        ).count()
        
        last_upload = db.query(DataUpload).filter(
            DataUpload.user_id == employee.id
        ).order_by(DataUpload.uploaded_at.desc()).first()
        
        result.append({
            "employee_id": employee.employee_id,
            "username": employee.username,
            "upload_count": upload_count,
            "analysis_count": analysis_count,
            "last_upload": last_upload.uploaded_at.isoformat() if last_upload else None
        })
    
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


def _call_openai_for_comments(campaigns: List[dict]) -> Dict[str, str]:
    """
    调用 OpenAI(ChatGPT) 对 6 条广告进行点评，返回：campaign_name -> comment
    - 若未配置 OPENAI_API_KEY 或调用失败，抛异常由上层兜底为规则点评
    """
    import json
    import urllib.request
    import urllib.error

    api_key = (getattr(settings, "OPENAI_API_KEY", "") or "").strip()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not set")

    model = (getattr(settings, "OPENAI_MODEL", "") or "gpt-4o-mini").strip()
    base_url = (getattr(settings, "OPENAI_BASE_URL", "") or "https://api.openai.com/v1").strip().rstrip("/")

    # 只给高信号字段，减少 token
    payload_rows = []
    for c in campaigns:
        payload_rows.append({
            "campaign_name": c.get("campaign_name"),
            "roi": c.get("roi"),
            "orders": c.get("orders"),
            "commission": c.get("commission"),
            "cost": c.get("cost"),
            "clicks": c.get("clicks"),
            "cpc": c.get("cpc"),
        })

    system = (
        "你是资深Google广告投手。你将收到6条广告系列的汇总指标。"
        "请分别给出每条广告的点评与建议动作，要求简洁、可执行、中文。"
        "不要输出多余解释，严格输出JSON对象：key为campaign_name，value为点评字符串。"
        "点评建议要结合ROI、订单、成本，给出明确动作（加预算/不动/减停/优化方向）。"
    )
    user = {
        "range_note": "这些数据来自指定区间的汇总（Top3/Bottom3按ROI排序）",
        "campaigns": payload_rows,
    }

    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
        ],
        "temperature": 0.2,
        "max_tokens": 700,
    }

    req = urllib.request.Request(
        url=f"{base_url}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"OpenAI HTTPError: {e.code} {e.read().decode('utf-8', errors='ignore')}")
    except Exception as e:
        raise RuntimeError(f"OpenAI request failed: {str(e)}")

    data = json.loads(raw)
    content = (((data.get("choices") or [{}])[0]).get("message") or {}).get("content") or ""
    content = content.strip()
    # 解析 JSON
    try:
        parsed = json.loads(content)
        if isinstance(parsed, dict):
            return {str(k): str(v) for k, v in parsed.items()}
    except Exception:
        pass

    # 兜底：尝试从文本里截取 JSON（模型有时会包裹 ```json）
    if "{" in content and "}" in content:
        try:
            start = content.index("{")
            end = content.rindex("}") + 1
            parsed = json.loads(content[start:end])
            if isinstance(parsed, dict):
                return {str(k): str(v) for k, v in parsed.items()}
        except Exception:
            pass

    raise RuntimeError("OpenAI response is not valid JSON")


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
    from app.models.ad_campaign_daily_metric import AdCampaignDailyMetric
    from app.models.ad_campaign import AdCampaign

    target_user_id = current_user.id
    if user_id is not None:
        if current_user.role != UserRole.MANAGER:
            raise HTTPException(status_code=403, detail="Not enough permissions")
        target_user_id = int(user_id)

    start_d, end_d = _calc_range_dates(range)

    # 趋势：按天汇总
    trend_rows = db.query(
        AdCampaignDailyMetric.date.label("date"),
        func.sum(AdCampaignDailyMetric.commission).label("commission"),
        func.sum(AdCampaignDailyMetric.cost).label("cost"),
    ).filter(
        AdCampaignDailyMetric.user_id == target_user_id,
        AdCampaignDailyMetric.date >= start_d,
        AdCampaignDailyMetric.date <= end_d,
    ).group_by(
        AdCampaignDailyMetric.date
    ).order_by(
        AdCampaignDailyMetric.date.asc()
    ).all()

    trend = [
        {
            "date": r.date.strftime("%Y-%m-%d"),
            "commission": float(r.commission or 0.0),
            "cost": float(r.cost or 0.0),
        }
        for r in trend_rows
    ]

    # 广告系列聚合：按 campaign_id
    camp_rows = db.query(
        AdCampaign.id.label("campaign_id"),
        AdCampaign.campaign_name.label("campaign_name"),
        func.sum(AdCampaignDailyMetric.commission).label("commission"),
        func.sum(AdCampaignDailyMetric.cost).label("cost"),
        func.sum(AdCampaignDailyMetric.orders).label("orders"),
        func.sum(AdCampaignDailyMetric.clicks).label("clicks"),
        func.sum(AdCampaignDailyMetric.impressions).label("impressions"),
    ).join(
        AdCampaign, AdCampaign.id == AdCampaignDailyMetric.campaign_id
    ).filter(
        AdCampaignDailyMetric.user_id == target_user_id,
        AdCampaignDailyMetric.date >= start_d,
        AdCampaignDailyMetric.date <= end_d,
    ).group_by(
        AdCampaign.id, AdCampaign.campaign_name
    ).all()

    campaigns = []
    for r in camp_rows:
        commission = float(r.commission or 0.0)
        cost = float(r.cost or 0.0)
        orders = float(r.orders or 0.0)
        clicks = float(r.clicks or 0.0)
        impressions = float(r.impressions or 0.0)
        roi = ((commission - cost) / cost) if cost > 0 else None
        cpc = (cost / clicks) if clicks > 0 else None
        campaigns.append({
            "campaign_id": int(r.campaign_id),
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

    # 追加点评：优先 ChatGPT（若未配置Key/失败则回退规则点评）
    try:
        comments = _call_openai_for_comments(top3 + bottom3)
    except Exception:
        comments = {}

    for c in top3:
        c["ai_commentary"] = comments.get(c.get("campaign_name") or "", "") or _ai_commentary(c)
    for c in bottom3:
        c["ai_commentary"] = comments.get(c.get("campaign_name") or "", "") or _ai_commentary(c)

    return {
        "user_id": target_user_id,
        "range": range,
        "start_date": start_d.strftime("%Y-%m-%d"),
        "end_date": end_d.strftime("%Y-%m-%d"),
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
                    total_clicks += row.get("点击", 0) or 0
                    total_orders += row.get("订单数", 0) or 0
                    total_commission += row.get("保守佣金", 0) or 0
                    if row.get("保守EPC"):
                        epc_list.append(row["保守EPC"])
                    if row.get("保守ROI"):
                        roi_list.append(row["保守ROI"])
        
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




