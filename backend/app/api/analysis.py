"""
数据分析API
"""
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User, UserRole
from app.models.analysis_result import AnalysisResult
from app.models.data_upload import DataUpload
from app.schemas.analysis import AnalysisRequest, AnalysisResultResponse, AnalysisSummary
from app.services.analysis_service import AnalysisService

router = APIRouter(prefix="/api/analysis", tags=["analysis"])


@router.post("/process")
async def process_analysis(
    request: AnalysisRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """触发数据分析"""
    # 获取上传记录
    google_upload = db.query(DataUpload).filter(
        DataUpload.id == request.google_ads_upload_id
    ).first()
    affiliate_upload = db.query(DataUpload).filter(
        DataUpload.id == request.affiliate_upload_id
    ).first()
    
    if not google_upload or not affiliate_upload:
        raise HTTPException(status_code=404, detail="上传记录不存在")
    
    # 权限控制
    if current_user.role == "employee":
        if google_upload.user_id != current_user.id or affiliate_upload.user_id != current_user.id:
            raise HTTPException(status_code=403, detail="无权访问此数据")
    
    # 验证平台匹配：谷歌广告数据和联盟数据必须属于同一平台
    from app.models.affiliate_account import AffiliateAccount
    affiliate_account_id = request.affiliate_account_id or affiliate_upload.affiliate_account_id
    if not affiliate_account_id:
        raise HTTPException(status_code=400, detail="必须指定联盟账号")
    
    affiliate_account = db.query(AffiliateAccount).filter(
        AffiliateAccount.id == affiliate_account_id
    ).first()
    if not affiliate_account:
        raise HTTPException(status_code=404, detail="联盟账号不存在")
    
    # 检查平台匹配
    if google_upload.platform_id and google_upload.platform_id != affiliate_account.platform_id:
        raise HTTPException(
            status_code=400,
            detail=f"平台不匹配：谷歌广告数据属于平台ID {google_upload.platform_id}，但联盟账号属于平台ID {affiliate_account.platform_id}"
        )
    
    # 如果谷歌广告数据没有指定平台，自动设置为联盟账号的平台
    if not google_upload.platform_id:
        google_upload.platform_id = affiliate_account.platform_id
        db.commit()
    
    # 执行分析
    import logging
    logger = logging.getLogger(__name__)
    
    try:
        logger.info(f"开始分析: Google Ads文件={google_upload.file_path}, Affiliate文件={affiliate_upload.file_path}")
        analysis_service = AnalysisService()
        result = analysis_service.process_analysis(
            google_ads_file=google_upload.file_path,
            affiliate_file=affiliate_upload.file_path,
            user_id=current_user.id,
            platform_id=affiliate_account.platform_id,
            analysis_date=affiliate_upload.upload_date,
            db=db,
            # 传递操作指令相关参数
            past_seven_days_orders_global=request.past_seven_days_orders_global,
            max_cpc_global=request.max_cpc_global
        )
        
        if result["status"] == "failed":
            error_msg = result.get("error", "分析失败")
            logger.error(f"分析失败: {error_msg}")
            raise HTTPException(status_code=500, detail=f"分析失败: {error_msg}")
        
        total_rows = result.get('total_rows', 0)
        logger.info(f"分析完成: 处理了 {total_rows} 行数据")
        
        # 如果结果为0行，记录诊断信息
        if total_rows == 0 and "diagnosis" in result:
            logger.warning(f"分析结果为0行，诊断信息: {result.get('diagnosis', {})}")
            logger.warning(f"警告信息: {result.get('warning', '')}")
    except HTTPException:
        # 重新抛出HTTP异常，不记录
        raise
    except Exception as e:
        import traceback
        error_detail = str(e)
        error_traceback = traceback.format_exc()
        
        # 记录详细错误信息
        logger.error(f"分析过程出错: {error_detail}")
        logger.error(f"错误堆栈:\n{error_traceback}")
        
        # 打印到控制台（开发环境）
        print(f"\n{'='*60}")
        print(f"分析错误详情:")
        print(f"{'='*60}")
        print(f"错误信息: {error_detail}")
        print(f"\n完整堆栈跟踪:")
        print(error_traceback)
        print(f"{'='*60}\n")
        
        raise HTTPException(status_code=500, detail=f"分析过程出错: {error_detail}")
    
    # 保存分析结果
    analysis_result = AnalysisResult(
        user_id=current_user.id,
        affiliate_account_id=affiliate_account_id,
        upload_id_google=google_upload.id,
        upload_id_affiliate=affiliate_upload.id,
        analysis_date=affiliate_upload.upload_date,
        result_data=result
    )
    db.add(analysis_result)
    db.commit()
    db.refresh(analysis_result)
    
    response_data = {
        "id": analysis_result.id,
        "status": "completed",
        "summary": result.get("summary", {}),
        "total_rows": result.get("total_rows", 0)
    }
    
    # 如果结果为0行，包含诊断信息
    if result.get("total_rows", 0) == 0 and "diagnosis" in result:
        response_data["diagnosis"] = result.get("diagnosis", {})
        response_data["warning"] = result.get("warning", "")
    
    return response_data


@router.get("/results", response_model=List[AnalysisResultResponse])
async def get_analysis_results(
    account_id: Optional[int] = None,
    platform_id: Optional[int] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取分析结果列表"""
    from app.models.affiliate_account import AffiliateAccount
    
    query = db.query(AnalysisResult)
    
    # 权限控制
    if current_user.role == "employee":
        query = query.filter(AnalysisResult.user_id == current_user.id)
    
    # 筛选条件
    if account_id:
        query = query.filter(AnalysisResult.affiliate_account_id == account_id)
    if platform_id:
        query = query.join(AffiliateAccount).filter(
            AffiliateAccount.platform_id == platform_id
        )
    if start_date:
        query = query.filter(AnalysisResult.analysis_date >= start_date)
    if end_date:
        query = query.filter(AnalysisResult.analysis_date <= end_date)
    
    results = query.order_by(AnalysisResult.analysis_date.desc()).all()
    return results


@router.get("/results/{result_id}", response_model=AnalysisResultResponse)
async def get_analysis_result(
    result_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取分析结果详情"""
    result = db.query(AnalysisResult).filter(AnalysisResult.id == result_id).first()
    if not result:
        raise HTTPException(status_code=404, detail="分析结果不存在")
    
    # 权限控制
    if current_user.role == "employee" and result.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权访问此结果")
    
    return result


@router.delete("/results/{result_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_analysis_result(
    result_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """删除分析结果"""
    result = db.query(AnalysisResult).filter(AnalysisResult.id == result_id).first()
    if not result:
        raise HTTPException(status_code=404, detail="分析结果不存在")

    # 权限控制：员工只能删自己的；经理可删全部
    if current_user.role == UserRole.EMPLOYEE and result.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权删除此结果")

    db.delete(result)
    db.commit()
    return None




