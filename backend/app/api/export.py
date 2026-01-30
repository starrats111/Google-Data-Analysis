"""
导出API接口
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from typing import Optional
from pathlib import Path

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.services.export_service import ExportService

router = APIRouter(prefix="/api/export", tags=["export"])


@router.get("/analysis")
async def export_analysis_results(
    account_id: Optional[int] = Query(None, description="联盟账号ID"),
    platform_id: Optional[int] = Query(None, description="平台ID"),
    start_date: Optional[str] = Query(None, description="开始日期，格式：YYYY-MM-DD"),
    end_date: Optional[str] = Query(None, description="结束日期，格式：YYYY-MM-DD"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    导出分析结果
    
    员工：只能导出自己的数据
    经理：可以导出所有员工的数据
    """
    try:
        export_service = ExportService()
        
        filepath = export_service.export_analysis_results(
            db=db,
            user=current_user,
            account_id=account_id,
            platform_id=platform_id,
            start_date=start_date,
            end_date=end_date
        )
        
        if not Path(filepath).exists():
            raise HTTPException(status_code=404, detail="导出文件不存在")
        
        filename = Path(filepath).name
        
        return FileResponse(
            path=filepath,
            filename=filename,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
        
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"导出失败: {str(e)}")


@router.get("/dashboard")
async def export_dashboard_data(
    employee_id: Optional[int] = Query(None, description="员工ID"),
    platform_id: Optional[int] = Query(None, description="平台ID"),
    account_id: Optional[int] = Query(None, description="联盟账号ID"),
    start_date: Optional[str] = Query(None, description="开始日期，格式：YYYY-MM-DD"),
    end_date: Optional[str] = Query(None, description="结束日期，格式：YYYY-MM-DD"),
    group_by: Optional[str] = Query(None, description="分组方式：employee, platform, account"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    导出数据总览（经理专用）
    
    只有经理可以访问此接口
    """
    if current_user.role != 'manager':
        raise HTTPException(status_code=403, detail="只有经理可以导出数据总览")
    
    try:
        export_service = ExportService()
        
        filepath = export_service.export_analysis_results(
            db=db,
            user=current_user,
            account_id=account_id,
            platform_id=platform_id,
            start_date=start_date,
            end_date=end_date,
            group_by=group_by
        )
        
        if not Path(filepath).exists():
            raise HTTPException(status_code=404, detail="导出文件不存在")
        
        filename = Path(filepath).name
        
        return FileResponse(
            path=filepath,
            filename=filename,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
        
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"导出失败: {str(e)}")














