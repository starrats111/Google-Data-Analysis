"""
广告系列API
"""
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form
from sqlalchemy.orm import Session
from sqlalchemy import or_

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.ad_campaign import AdCampaign
from app.models.affiliate_account import AffiliateAccount
from app.schemas.ad_campaign import (
    AdCampaignCreate,
    AdCampaignUpdate,
    AdCampaignResponse,
    AdCampaignBatchUpdate,
)
import pandas as pd
from pathlib import Path
import logging
import tempfile
import shutil

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ad-campaigns", tags=["ad-campaigns"])


@router.get("", response_model=List[AdCampaignResponse])
async def get_ad_campaigns(
    platform_id: Optional[int] = None,
    affiliate_account_id: Optional[int] = None,
    merchant_id: Optional[str] = None,
    campaign_name: Optional[str] = None,
    status: Optional[str] = None,
    metrics_date: Optional[str] = None,  # YYYY-MM-DD：可选，返回该日每日指标到列表中
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取广告系列列表（支持搜索）"""
    query = db.query(AdCampaign)
    
    # 权限控制：员工只能看自己的广告
    if current_user.role == "employee":
        query = query.filter(AdCampaign.user_id == current_user.id)
    
    # 筛选条件
    if platform_id:
        query = query.filter(AdCampaign.platform_id == platform_id)
    if affiliate_account_id:
        query = query.filter(AdCampaign.affiliate_account_id == affiliate_account_id)
    if merchant_id:
        query = query.filter(AdCampaign.merchant_id.contains(merchant_id))
    if campaign_name:
        query = query.filter(AdCampaign.campaign_name.contains(campaign_name))
    if status:
        query = query.filter(AdCampaign.status == status)
    
    campaigns = query.order_by(AdCampaign.created_at.desc()).all()

    # 可选：拼接每日指标
    if metrics_date:
        from datetime import datetime
        from app.models.ad_campaign_daily_metric import AdCampaignDailyMetric

        try:
            d = datetime.strptime(metrics_date, "%Y-%m-%d").date()
        except Exception:
            raise HTTPException(status_code=400, detail="metrics_date 日期格式错误，请使用YYYY-MM-DD")

        ids = [c.id for c in campaigns]
        if ids:
            metrics = db.query(AdCampaignDailyMetric).filter(
                AdCampaignDailyMetric.user_id == current_user.id,
                AdCampaignDailyMetric.campaign_id.in_(ids),
                AdCampaignDailyMetric.date == d,
            ).all()
            m_map = {m.campaign_id: m for m in metrics}
        else:
            m_map = {}

        # 给 response 补充字段（Pydantic 会从 attributes 读取；这里直接挂动态属性）
        for c in campaigns:
            m = m_map.get(c.id)
            setattr(c, "metrics_date", metrics_date)
            if not m:
                continue
            setattr(c, "daily_clicks", float(m.clicks or 0.0))
            setattr(c, "daily_orders", float(m.orders or 0.0))
            setattr(c, "daily_budget", float(m.budget or 0.0))
            setattr(c, "daily_cpc", float(m.cpc or 0.0))
            setattr(c, "daily_cost", float(m.cost or 0.0))
            setattr(c, "daily_commission", float(m.commission or 0.0))
            setattr(c, "daily_past_seven_days_order_days", float(m.past_seven_days_order_days or 0.0))
            setattr(c, "daily_current_max_cpc", float(m.current_max_cpc or 0.0))

    return campaigns


@router.post("", response_model=AdCampaignResponse, status_code=status.HTTP_201_CREATED)
async def create_ad_campaign(
    campaign: AdCampaignCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """创建广告系列"""
    # 验证联盟账号是否存在且属于当前用户
    account = db.query(AffiliateAccount).filter(
        AffiliateAccount.id == campaign.affiliate_account_id
    ).first()
    
    if not account:
        raise HTTPException(status_code=404, detail="联盟账号不存在")
    
    # 权限控制
    if current_user.role == "employee" and account.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权访问此联盟账号")
    
    # 创建广告系列
    db_campaign = AdCampaign(
        user_id=current_user.id,
        affiliate_account_id=campaign.affiliate_account_id,
        platform_id=campaign.platform_id,
        cid_account=campaign.cid_account,
        url=campaign.url,
        merchant_id=campaign.merchant_id,
        country=campaign.country,
        campaign_name=campaign.campaign_name,
        ad_time=campaign.ad_time,
        keywords=campaign.keywords,
        status=campaign.status
    )
    
    db.add(db_campaign)
    db.commit()
    db.refresh(db_campaign)
    
    return db_campaign


@router.put("/{campaign_id}", response_model=AdCampaignResponse)
async def update_ad_campaign(
    campaign_id: int,
    campaign: AdCampaignUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """更新广告系列"""
    db_campaign = db.query(AdCampaign).filter(AdCampaign.id == campaign_id).first()
    
    if not db_campaign:
        raise HTTPException(status_code=404, detail="广告系列不存在")
    
    # 权限控制
    if current_user.role == "employee" and db_campaign.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权修改此广告系列")
    
    # 更新字段
    update_data = campaign.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(db_campaign, key, value)
    
    db.commit()
    db.refresh(db_campaign)
    
    return db_campaign


@router.delete("/{campaign_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_ad_campaign(
    campaign_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """删除广告系列"""
    db_campaign = db.query(AdCampaign).filter(AdCampaign.id == campaign_id).first()
    
    if not db_campaign:
        raise HTTPException(status_code=404, detail="广告系列不存在")
    
    # 权限控制
    if current_user.role == "employee" and db_campaign.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权删除此广告系列")
    
    db.delete(db_campaign)
    db.commit()
    
    return None


@router.post("/batch-update", status_code=status.HTTP_200_OK)
async def batch_update_campaigns(
    batch_update: AdCampaignBatchUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """批量更新广告系列状态"""
    query = db.query(AdCampaign).filter(AdCampaign.id.in_(batch_update.campaign_ids))
    
    # 权限控制
    if current_user.role == "employee":
        query = query.filter(AdCampaign.user_id == current_user.id)
    
    campaigns = query.all()
    
    if len(campaigns) != len(batch_update.campaign_ids):
        raise HTTPException(status_code=400, detail="部分广告系列不存在或无权限")
    
    # 批量更新状态
    for campaign in campaigns:
        campaign.status = batch_update.status
    
    db.commit()
    
    return {"message": f"成功更新 {len(campaigns)} 个广告系列的状态"}


@router.post("/import", status_code=status.HTTP_200_OK)
async def import_ad_campaigns(
    file: UploadFile = File(...),
    affiliate_account_id: int = Form(...),
    platform_id: int = Form(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """从Excel文件导入广告系列"""
    try:
        # 验证文件类型
        file_ext = Path(file.filename).suffix.lower()
        if file_ext not in ['.xlsx', '.xls']:
            raise HTTPException(
                status_code=400,
                detail="只支持Excel文件格式（.xlsx, .xls）"
            )
        
        # 验证联盟账号
        account = db.query(AffiliateAccount).filter(
            AffiliateAccount.id == affiliate_account_id
        ).first()
        
        if not account:
            raise HTTPException(status_code=404, detail="联盟账号不存在")
        
        # 权限控制
        if current_user.role == "employee" and account.user_id != current_user.id:
            raise HTTPException(status_code=403, detail="无权访问此联盟账号")
        
        # 保存上传的文件到临时目录
        import tempfile
        import shutil
        
        with tempfile.NamedTemporaryFile(delete=False, suffix=file_ext) as tmp_file:
            shutil.copyfileobj(file.file, tmp_file)
            file_path = Path(tmp_file.name)
        
        # 读取Excel（更稳健的标题行检测：用header=None扫描原始行，避免“RW”等大标题被当成表头）
        preview = pd.read_excel(file_path, engine='openpyxl', header=None, nrows=30)

        def _row_to_text(r) -> str:
            parts = []
            for cell in r:
                if pd.notna(cell):
                    s = str(cell).strip()
                    if s:
                        parts.append(s)
            return " ".join(parts)

        # 检测标题行：优先找同时包含“商家ID”和“广告系列”的行，其次找包含关键字段较多的行
        required_cn = ["商家ID", "广告系列"]
        required_en = ["Merchant ID", "Campaign"]
        candidate_keywords = ["CID", "CID账号", "网址", "URL", "国家", "关键词", "Keyword", "Campaign Name"]

        best_header_row = 0
        best_score = -1
        for i in range(min(20, len(preview))):
            row_text = _row_to_text(preview.iloc[i])
            if not row_text:
                continue

            has_required_cn = all(k in row_text for k in required_cn)
            has_required_en = all(k in row_text for k in required_en)
            score = 0
            if has_required_cn or has_required_en:
                score += 100
            for k in candidate_keywords + required_cn + required_en:
                if k in row_text:
                    score += 10

            if score > best_score:
                best_score = score
                best_header_row = i

            # 直接命中强条件就提前结束
            if has_required_cn or has_required_en:
                best_header_row = i
                break

        # 重新读取：使用检测到的标题行
        df = pd.read_excel(file_path, engine='openpyxl', header=best_header_row)
        
        # 映射列名（支持中英文）
        column_mapping = {
            'CID账号': 'cid_account',
            'CID Account': 'cid_account',
            'CID': 'cid_account',
            '网址': 'url',
            'URL': 'url',
            'Url': 'url',
            '商家ID': 'merchant_id',
            'Merchant ID': 'merchant_id',
            'MerchantId': 'merchant_id',
            '国家': 'country',
            'Country': 'country',
            '广告系列': 'campaign_name',
            'Campaign': 'campaign_name',
            'Campaign Name': 'campaign_name',
            '广告时间': 'ad_time',
            'Ad Time': 'ad_time',
            '关键词': 'keywords',
            'Keywords': 'keywords',
            'Keyword': 'keywords',
        }
        
        # 标准化列名
        df.columns = df.columns.astype(str).str.strip()
        for old_col, new_col in column_mapping.items():
            if old_col in df.columns:
                df.rename(columns={old_col: new_col}, inplace=True)
        
        # 检查必需字段（失败时输出实际识别到的列名，便于定位）
        if 'merchant_id' not in df.columns or 'campaign_name' not in df.columns:
            logger.warning(f"导入广告系列：标题行检测到第 {best_header_row} 行，但未识别到必需列。当前列名={list(df.columns)}")
            raise HTTPException(status_code=400, detail="Excel文件必须包含'商家ID'和'广告系列'列")
        
        # 导入数据
        imported_count = 0
        skipped_count = 0
        
        for _, row in df.iterrows():
            try:
                merchant_id = str(row.get('merchant_id', '')).strip()
                campaign_name = str(row.get('campaign_name', '')).strip()
                
                if not merchant_id or not campaign_name or merchant_id == 'nan' or campaign_name == 'nan':
                    skipped_count += 1
                    continue
                
                # 检查是否已存在
                existing = db.query(AdCampaign).filter(
                    AdCampaign.user_id == current_user.id,
                    AdCampaign.merchant_id == merchant_id,
                    AdCampaign.campaign_name == campaign_name,
                    AdCampaign.platform_id == platform_id
                ).first()
                
                if existing:
                    skipped_count += 1
                    continue
                
                # 创建新记录
                campaign = AdCampaign(
                    user_id=current_user.id,
                    affiliate_account_id=affiliate_account_id,
                    platform_id=platform_id,
                    cid_account=str(row.get('cid_account', '')).strip() if pd.notna(row.get('cid_account')) else None,
                    url=str(row.get('url', '')).strip() if pd.notna(row.get('url')) else None,
                    merchant_id=merchant_id,
                    country=str(row.get('country', '')).strip() if pd.notna(row.get('country')) else None,
                    campaign_name=campaign_name,
                    ad_time=str(row.get('ad_time', '')).strip() if pd.notna(row.get('ad_time')) else None,
                    keywords=str(row.get('keywords', '')).strip() if pd.notna(row.get('keywords')) else None,
                    status="启用"
                )
                
                db.add(campaign)
                imported_count += 1
                
            except Exception as e:
                logger.warning(f"导入行失败: {e}")
                skipped_count += 1
                continue
        
        db.commit()
        
        # 删除临时文件
        try:
            if file_path.exists():
                file_path.unlink()
        except Exception as e:
            logger.warning(f"删除临时文件失败: {e}")
        
        return {
            "message": "导入完成",
            "imported": imported_count,
            "skipped": skipped_count
        }
        
    except HTTPException:
        # 重新抛出HTTP异常
        raise
    except Exception as e:
        logger.error(f"导入广告系列失败: {e}")
        # 确保删除临时文件
        try:
            if 'file_path' in locals() and file_path.exists():
                file_path.unlink()
        except:
            pass
        raise HTTPException(status_code=500, detail=f"导入失败: {str(e)}")

