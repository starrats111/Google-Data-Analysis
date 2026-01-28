"""
数据总览API（经理专用）
"""
from typing import List, Optional, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, and_

from app.database import get_db
from app.middleware.auth import get_current_manager
from app.models.user import User
from app.models.analysis_result import AnalysisResult
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.data_upload import DataUpload

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
    from app.models.user import UserRole
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




