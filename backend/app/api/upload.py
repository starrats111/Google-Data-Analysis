"""
文件上传API

安全改进:
- 文件扩展名白名单验证
- MIME 类型验证（警告级别）
- 文件大小限制
"""
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, status
from sqlalchemy.orm import Session
from pathlib import Path
from datetime import datetime, date
import shutil
import logging

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.data_upload import DataUpload, UploadType, UploadStatus
from app.models.affiliate_account import AffiliateAccount
from app.schemas.upload import DataUploadResponse
from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/upload", tags=["upload"])

# MIME 类型白名单映射
ALLOWED_MIME_TYPES = {
    '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    '.xls': ['application/vnd.ms-excel'],
    '.csv': ['text/csv', 'application/csv', 'text/plain'],  # CSV 可能有多种 MIME
}


def validate_upload_file(file: UploadFile) -> str:
    """验证上传文件的扩展名和 MIME 类型
    
    Returns:
        文件扩展名
    
    Raises:
        HTTPException: 文件类型不合法
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="文件名不能为空")
    
    # 1. 验证扩展名（严格）
    file_ext = Path(file.filename).suffix.lower()
    if file_ext not in settings.ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的文件格式: {file_ext}，允许: {', '.join(settings.ALLOWED_EXTENSIONS)}"
        )
    
    # 2. 验证 MIME 类型（警告级别，不阻断）
    expected_mimes = ALLOWED_MIME_TYPES.get(file_ext, [])
    if file.content_type and expected_mimes:
        if file.content_type not in expected_mimes:
            # 记录警告但不阻断（浏览器可能发送不准确的 MIME）
            logger.warning(
                f"MIME类型不匹配: 文件={file.filename}, "
                f"扩展名={file_ext}, "
                f"实际MIME={file.content_type}, "
                f"预期MIME={expected_mimes}"
            )
    
    return file_ext


def save_upload_file(file: UploadFile, user_id: int, upload_type: str) -> str:
    """保存上传的文件"""
    upload_dir = Path(settings.UPLOAD_FOLDER) / str(user_id) / upload_type
    upload_dir.mkdir(parents=True, exist_ok=True)
    
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    file_extension = Path(file.filename).suffix
    filename = f"{timestamp}_{file.filename}"
    file_path = upload_dir / filename
    
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    
    return str(file_path)


@router.post("/google-ads", response_model=DataUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_google_ads(
    file: UploadFile = File(...),
    upload_date: str = Form(...),  # YYYY-MM-DD
    platform_id: Optional[int] = Form(None),  # 联盟平台ID
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """上传谷歌广告数据（表1）"""
    # 验证文件类型（扩展名 + MIME）
    validate_upload_file(file)
    
    # 验证文件大小
    file.file.seek(0, 2)  # 移动到文件末尾
    file_size = file.file.tell()
    file.file.seek(0)  # 重置到开头
    
    if file_size > settings.MAX_FILE_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"文件大小超过限制（最大{settings.MAX_FILE_SIZE / 1024 / 1024}MB）"
        )
    
    # 验证平台ID（如果提供）
    if platform_id:
        from app.models.affiliate_account import AffiliatePlatform
        platform = db.query(AffiliatePlatform).filter(AffiliatePlatform.id == platform_id).first()
        if not platform:
            raise HTTPException(status_code=404, detail="联盟平台不存在")
    
    # 解析日期
    try:
        data_date = datetime.strptime(upload_date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="日期格式错误，请使用YYYY-MM-DD格式")
    
    # 保存文件
    file_path = save_upload_file(file, current_user.id, "google_ads")
    
    # 创建上传记录
    upload = DataUpload(
        user_id=current_user.id,
        upload_type=UploadType.GOOGLE_ADS,
        file_name=file.filename,
        file_path=file_path,
        upload_date=data_date,
        platform_id=platform_id,  # 添加平台ID
        status=UploadStatus.COMPLETED
    )
    db.add(upload)
    db.commit()
    db.refresh(upload)
    
    return upload


@router.post("/affiliate", response_model=DataUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_affiliate(
    file: UploadFile = File(...),
    upload_date: str = Form(...),  # YYYY-MM-DD
    affiliate_account_id: int = Form(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """上传联盟数据（表2）"""
    # 验证联盟账号
    account = db.query(AffiliateAccount).filter(
        AffiliateAccount.id == affiliate_account_id
    ).first()
    if not account:
        raise HTTPException(status_code=404, detail="联盟账号不存在")
    
    # 权限控制：只能使用自己的账号
    if account.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权使用此联盟账号")
    
    # 验证文件类型（扩展名 + MIME）
    validate_upload_file(file)
    
    # 验证文件大小
    file.file.seek(0, 2)
    file_size = file.file.tell()
    file.file.seek(0)
    
    if file_size > settings.MAX_FILE_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"文件大小超过限制（最大{settings.MAX_FILE_SIZE / 1024 / 1024}MB）"
        )
    
    # 解析日期
    try:
        data_date = datetime.strptime(upload_date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="日期格式错误，请使用YYYY-MM-DD格式")
    
    # 保存文件
    file_path = save_upload_file(file, current_user.id, "affiliate")
    
    # 创建上传记录
    upload = DataUpload(
        user_id=current_user.id,
        affiliate_account_id=affiliate_account_id,
        upload_type=UploadType.AFFILIATE,
        file_name=file.filename,
        file_path=file_path,
        upload_date=data_date,
        status=UploadStatus.COMPLETED
    )
    db.add(upload)
    db.commit()
    db.refresh(upload)
    
    return upload


@router.get("/history", response_model=List[DataUploadResponse])
async def get_upload_history(
    upload_type: Optional[UploadType] = None,
    affiliate_account_id: Optional[int] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取上传历史"""
    try:
        query = db.query(DataUpload)
        
        # 权限控制：员工只能看自己的
        if current_user.role in ("employee", "member", "leader"):
            query = query.filter(DataUpload.user_id == current_user.id)
        
        # 筛选条件
        if upload_type:
            query = query.filter(DataUpload.upload_type == upload_type)
        if affiliate_account_id:
            query = query.filter(DataUpload.affiliate_account_id == affiliate_account_id)
        
        uploads = query.order_by(DataUpload.uploaded_at.desc()).all()
        return uploads
    except Exception as e:
        import logging
        logging.error(f"获取上传历史失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"获取上传历史失败: {str(e)}")


@router.get("/{upload_id}/columns")
async def get_upload_columns(
    upload_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取上传文件的列名（用于调试）"""
    upload = db.query(DataUpload).filter(DataUpload.id == upload_id).first()
    if not upload:
        raise HTTPException(status_code=404, detail="上传记录不存在")
    
    # 权限控制
    if current_user.role in ("employee", "member", "leader") and upload.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权访问此记录")
    
    try:
        from app.services.analysis_service import AnalysisService
        service = AnalysisService()
        df = service._read_file(upload.file_path)
        
        return {
            "upload_id": upload_id,
            "file_name": upload.file_name,
            "upload_type": upload.upload_type,
            "columns": df.columns.tolist(),
            "column_count": len(df.columns),
            "row_count": len(df),
            "sample_data": df.head(3).to_dict('records') if not df.empty else []
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取文件失败: {str(e)}")


@router.delete("/{upload_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_upload(
    upload_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """删除上传记录"""
    upload = db.query(DataUpload).filter(DataUpload.id == upload_id).first()
    if not upload:
        raise HTTPException(status_code=404, detail="上传记录不存在")
    
    # 权限控制：员工只能删除自己的上传
    if current_user.role in ("employee", "member", "leader") and upload.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权删除此记录")
    
    # 删除相关的分析结果（级联删除）
    from app.models.analysis_result import AnalysisResult
    related_analyses = db.query(AnalysisResult).filter(
        (AnalysisResult.upload_id_google == upload_id) | 
        (AnalysisResult.upload_id_affiliate == upload_id)
    ).all()
    
    analysis_count = len(related_analyses)
    
    # 删除所有相关的分析结果
    for analysis in related_analyses:
        db.delete(analysis)
    
    # 如果有关联的分析结果，先提交删除
    if analysis_count > 0:
        db.commit()
        db.refresh(upload)  # 刷新上传记录
    
    # 删除文件（确保路径安全）
    import os
    from pathlib import Path
    if upload.file_path:
        try:
            file_path = Path(upload.file_path)
            # 确保文件路径在允许的目录内（安全检查）
            upload_base = Path(settings.UPLOAD_FOLDER).resolve()
            if file_path.exists() and str(file_path.resolve()).startswith(str(upload_base)):
                file_path.unlink()
        except Exception as e:
            # 文件删除失败不影响记录删除，但记录日志
            import logging
            logging.warning(f"删除文件失败: {upload.file_path}, 错误: {str(e)}")
    
    # 删除数据库记录
    db.delete(upload)
    db.commit()
    
    # 记录删除信息（用于日志）
    if analysis_count > 0:
        import logging
        logging.info(f"删除上传记录 {upload_id}，同时删除了 {analysis_count} 个相关分析结果")
    
    return None


@router.get("/{upload_id}", response_model=DataUploadResponse)
async def get_upload(
    upload_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取上传记录详情"""
    upload = db.query(DataUpload).filter(DataUpload.id == upload_id).first()
    if not upload:
        raise HTTPException(status_code=404, detail="上传记录不存在")
    
    # 权限控制
    if current_user.role in ("employee", "member", "leader") and upload.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权访问此记录")
    
    return upload
async def get_upload_columns(
    upload_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取上传文件的列名（用于调试）"""
    upload = db.query(DataUpload).filter(DataUpload.id == upload_id).first()
    if not upload:
        raise HTTPException(status_code=404, detail="上传记录不存在")
    
    # 权限控制
    if current_user.role in ("employee", "member", "leader") and upload.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权访问此记录")
    
    try:
        from app.services.analysis_service import AnalysisService
        service = AnalysisService()
        df = service._read_file(upload.file_path)
        
        return {
            "upload_id": upload_id,
            "file_name": upload.file_name,
            "upload_type": upload.upload_type,
            "columns": df.columns.tolist(),
            "column_count": len(df.columns),
            "row_count": len(df),
            "sample_data": df.head(3).to_dict('records') if not df.empty else []
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取文件失败: {str(e)}")




