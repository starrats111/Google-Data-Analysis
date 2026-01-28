"""
数据上传相关的Pydantic模型
"""
from pydantic import BaseModel
from typing import Optional
from datetime import date, datetime
from app.models.data_upload import UploadType, UploadStatus


class DataUploadBase(BaseModel):
    upload_type: UploadType
    file_name: str
    upload_date: date
    affiliate_account_id: Optional[int] = None
    platform_id: Optional[int] = None  # 联盟平台ID（用于谷歌广告数据）


class DataUploadCreate(DataUploadBase):
    pass


class DataUploadResponse(DataUploadBase):
    id: int
    user_id: int
    file_path: str
    status: UploadStatus
    uploaded_at: datetime
    
    class Config:
        from_attributes = True


