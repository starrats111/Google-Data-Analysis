"""
出价管理 API
管理广告系列出价策略和关键词CPC
"""
import logging
from datetime import datetime
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.google_ads_api_data import GoogleMccAccount
from app.models.keyword_bid import KeywordBid, CampaignBidStrategy, BidStrategyChange

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/bids", tags=["bids"])


def dollars_to_micros(amount: float) -> int:
    """
    将美元金额转换为 micros（微单位）
    确保结果是 10000 的倍数（Google Ads 要求 CPC 必须是 $0.01 的倍数）
    
    Args:
        amount: 美元金额（如 0.37）
    Returns:
        micros 值（如 370000）
    """
    # 先四舍五入到最近的 0.01 美元
    rounded_cents = round(amount * 100)
    # 转换为 micros（1 美分 = 10000 micros）
    return rounded_cents * 10000


class SyncBidDataRequest(BaseModel):
    mcc_id: int


class ChangeToManualCpcRequest(BaseModel):
    mcc_id: int
    customer_id: str
    campaign_id: str
    cpc_bid_ceiling: Optional[float] = None  # 可选的CPC上限


class SetKeywordCpcRequest(BaseModel):
    mcc_id: int
    customer_id: str
    ad_group_id: str
    criterion_id: str
    cpc_amount: float  # 标准单位（美元/人民币）


class BatchSetKeywordCpcRequest(BaseModel):
    mcc_id: int
    customer_id: str
    keywords: List[dict]  # [{"ad_group_id": "", "criterion_id": "", "cpc_amount": 0.0}]


class ParseCpcSuggestionsRequest(BaseModel):
    ai_report: str  # AI生成的报告文本


class CpcAdjustmentItem(BaseModel):
    campaign_name: str
    campaign_id: Optional[str] = None
    current_cpc: float
    target_cpc: float
    change_percent: float
    reason: str
    priority: str = "medium"


class ApplyCpcChangesRequest(BaseModel):
    mcc_id: int
    customer_id: str
    adjustments: List[dict]  # 从预览返回的调整列表


class KeywordCpcItem(BaseModel):
    keyword_id: str  # criterion_id
    keyword_text: str
    current_cpc: float
    target_cpc: float
    ad_group_id: str
    selected: bool = True  # 是否选中执行


class CampaignDeployment(BaseModel):
    campaign_name: str
    campaign_id: Optional[str] = None
    customer_id: Optional[str] = None
    mcc_id: Optional[int] = None
    keywords: List[KeywordCpcItem] = []
    budget_current: Optional[float] = None
    budget_target: Optional[float] = None
    budget_selected: bool = True


class OneClickDeployRequest(BaseModel):
    campaigns: List[CampaignDeployment]


@router.get("/strategies")
async def get_bid_strategies(
    mcc_id: Optional[int] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取广告系列出价策略列表"""
    query = db.query(CampaignBidStrategy).filter(
        CampaignBidStrategy.user_id == current_user.id
    )
    
    if mcc_id:
        query = query.filter(CampaignBidStrategy.mcc_id == mcc_id)
    
    strategies = query.order_by(CampaignBidStrategy.campaign_name).all()
    
    return [{
        "id": s.id,
        "mcc_id": s.mcc_id,
        "customer_id": s.customer_id,
        "campaign_id": s.campaign_id,
        "campaign_name": s.campaign_name,
        "bidding_strategy_type": s.bidding_strategy_type,
        "bidding_strategy_name": s.bidding_strategy_name,
        "is_manual_cpc": s.is_manual_cpc,
        "enhanced_cpc_enabled": s.enhanced_cpc_enabled,
        "max_cpc_limit": s.max_cpc_limit,
        "avg_cpc": s.avg_cpc,
        "last_sync_at": s.last_sync_at.isoformat() if s.last_sync_at else None,
    } for s in strategies]


@router.get("/keywords")
async def get_keyword_bids(
    mcc_id: Optional[int] = None,
    campaign_id: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取关键词CPC出价列表"""
    query = db.query(KeywordBid).filter(
        KeywordBid.user_id == current_user.id
    )
    
    if mcc_id:
        query = query.filter(KeywordBid.mcc_id == mcc_id)
    if campaign_id:
        query = query.filter(KeywordBid.campaign_id == campaign_id)
    
    keywords = query.order_by(KeywordBid.campaign_name, KeywordBid.keyword_text).all()
    
    return [{
        "id": k.id,
        "mcc_id": k.mcc_id,
        "customer_id": k.customer_id,
        "campaign_id": k.campaign_id,
        "campaign_name": k.campaign_name,
        "ad_group_id": k.ad_group_id,
        "ad_group_name": k.ad_group_name,
        "criterion_id": k.criterion_id,
        "keyword_text": k.keyword_text,
        "match_type": k.match_type,
        "max_cpc": k.max_cpc,
        "effective_cpc": k.effective_cpc,
        "avg_cpc": k.avg_cpc,
        "status": k.status,
        "quality_score": k.quality_score,
        "last_sync_at": k.last_sync_at.isoformat() if k.last_sync_at else None,
    } for k in keywords]


@router.post("/sync")
async def sync_bid_data(
    request: SyncBidDataRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """同步出价策略和关键词CPC数据"""
    mcc = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.id == request.mcc_id,
        GoogleMccAccount.user_id == current_user.id
    ).first()
    
    if not mcc:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    # 在后台执行同步
    background_tasks.add_task(
        _sync_bid_data_task,
        request.mcc_id,
        current_user.id
    )
    
    return {
        "success": True,
        "message": "同步任务已启动，请稍后刷新查看"
    }


def _sync_bid_data_task(mcc_id: int, user_id: int):
    """后台任务：同步出价数据"""
    from app.database import SessionLocal
    from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
    
    db = SessionLocal()
    try:
        mcc = db.query(GoogleMccAccount).filter(GoogleMccAccount.id == mcc_id).first()
        if not mcc:
            logger.error(f"MCC {mcc_id} 不存在")
            return
        
        sync_service = GoogleAdsServiceAccountSync(db)
        result = sync_service._create_client(mcc)
        
        if not result:
            logger.error(f"无法创建 MCC {mcc_id} 的 Google Ads 客户端")
            return
        
        # _create_client 返回 (client, mcc_customer_id) 元组
        client, mcc_customer_id = result
        
        # 获取客户账号列表
        customers = sync_service.get_accessible_customers(client, mcc_customer_id)
        
        for customer in customers:
            customer_id = customer["id"]
            
            try:
                # 同步出价策略
                strategies = sync_service.fetch_campaign_bid_strategies(client, customer_id)
                for s in strategies:
                    existing = db.query(CampaignBidStrategy).filter(
                        CampaignBidStrategy.user_id == user_id,
                        CampaignBidStrategy.campaign_id == s["campaign_id"]
                    ).first()
                    
                    if existing:
                        existing.bidding_strategy_type = s["bidding_strategy_type"]
                        existing.bidding_strategy_name = s["bidding_strategy_name"]
                        existing.is_manual_cpc = s["is_manual_cpc"]
                        existing.enhanced_cpc_enabled = s["enhanced_cpc_enabled"]
                        existing.max_cpc_limit = s["max_cpc_limit"]
                        existing.avg_cpc = s["avg_cpc"]
                        existing.last_sync_at = datetime.utcnow()
                    else:
                        new_strategy = CampaignBidStrategy(
                            user_id=user_id,
                            mcc_id=mcc_id,
                            customer_id=customer_id,
                            campaign_id=s["campaign_id"],
                            campaign_name=s["campaign_name"],
                            bidding_strategy_type=s["bidding_strategy_type"],
                            bidding_strategy_name=s["bidding_strategy_name"],
                            is_manual_cpc=s["is_manual_cpc"],
                            enhanced_cpc_enabled=s["enhanced_cpc_enabled"],
                            max_cpc_limit=s["max_cpc_limit"],
                            avg_cpc=s["avg_cpc"],
                        )
                        db.add(new_strategy)
                
                # 同步关键词出价
                keywords = sync_service.fetch_keyword_bids(client, customer_id)
                for k in keywords:
                    existing = db.query(KeywordBid).filter(
                        KeywordBid.user_id == user_id,
                        KeywordBid.criterion_id == k["criterion_id"]
                    ).first()
                    
                    if existing:
                        existing.max_cpc = k["max_cpc"]
                        existing.effective_cpc = k["effective_cpc"]
                        existing.avg_cpc = k["avg_cpc"]
                        existing.status = k["status"]
                        existing.quality_score = k["quality_score"]
                        existing.last_sync_at = datetime.utcnow()
                    else:
                        new_keyword = KeywordBid(
                            user_id=user_id,
                            mcc_id=mcc_id,
                            customer_id=customer_id,
                            campaign_id=k["campaign_id"],
                            campaign_name=k["campaign_name"],
                            ad_group_id=k["ad_group_id"],
                            ad_group_name=k["ad_group_name"],
                            criterion_id=k["criterion_id"],
                            keyword_text=k["keyword_text"],
                            match_type=k["match_type"],
                            max_cpc=k["max_cpc"],
                            effective_cpc=k["effective_cpc"],
                            avg_cpc=k["avg_cpc"],
                            status=k["status"],
                            quality_score=k["quality_score"],
                        )
                        db.add(new_keyword)
                
                db.commit()
                logger.info(f"客户账号 {customer_id} 出价数据同步完成")
                
            except Exception as e:
                logger.error(f"同步客户账号 {customer_id} 出价数据失败: {e}")
                continue
        
        logger.info(f"MCC {mcc_id} 出价数据同步完成")
        
    except Exception as e:
        logger.error(f"同步MCC {mcc_id} 出价数据失败: {e}", exc_info=True)
    finally:
        db.close()


@router.post("/change-to-manual")
async def change_to_manual_cpc(
    request: ChangeToManualCpcRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """将广告系列出价策略改为人工CPC"""
    from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
    
    mcc = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.id == request.mcc_id,
        GoogleMccAccount.user_id == current_user.id
    ).first()
    
    if not mcc:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    # 记录变更
    change_record = BidStrategyChange(
        user_id=current_user.id,
        mcc_id=request.mcc_id,
        customer_id=request.customer_id,
        campaign_id=request.campaign_id,
        old_strategy="UNKNOWN",  # 将在成功后更新
        new_strategy="MANUAL_CPC",
        status="pending"
    )
    db.add(change_record)
    db.commit()
    
    try:
        sync_service = GoogleAdsServiceAccountSync(db)
        client_result = sync_service._create_client(mcc)
        
        if not client_result:
            change_record.status = "failed"
            change_record.error_message = "无法创建Google Ads客户端"
            db.commit()
            raise HTTPException(status_code=500, detail="无法创建Google Ads客户端")
        
        client, _ = client_result
        
        # 执行切换
        cpc_ceiling = dollars_to_micros(request.cpc_bid_ceiling) if request.cpc_bid_ceiling else None
        result = sync_service.change_to_manual_cpc(
            client,
            request.customer_id,
            request.campaign_id,
            cpc_ceiling
        )
        
        if result["success"]:
            change_record.status = "success"
            change_record.completed_at = datetime.utcnow()
            
            # 更新本地策略记录
            strategy = db.query(CampaignBidStrategy).filter(
                CampaignBidStrategy.campaign_id == request.campaign_id
            ).first()
            if strategy:
                change_record.old_strategy = strategy.bidding_strategy_type
                strategy.bidding_strategy_type = "MANUAL_CPC"
                strategy.bidding_strategy_name = "每次点击费用人工出价"
                strategy.is_manual_cpc = True
            
            db.commit()
            return {
                "success": True,
                "message": "出价策略已成功切换为人工CPC"
            }
        else:
            change_record.status = "failed"
            change_record.error_message = result["message"]
            db.commit()
            raise HTTPException(status_code=500, detail=result["message"])
            
    except HTTPException:
        raise
    except Exception as e:
        change_record.status = "failed"
        change_record.error_message = str(e)
        db.commit()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/set-keyword-cpc")
async def set_keyword_cpc(
    request: SetKeywordCpcRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """设置单个关键词的最高CPC"""
    from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
    
    mcc = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.id == request.mcc_id,
        GoogleMccAccount.user_id == current_user.id
    ).first()
    
    if not mcc:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    try:
        sync_service = GoogleAdsServiceAccountSync(db)
        client_result = sync_service._create_client(mcc)
        
        if not client_result:
            raise HTTPException(status_code=500, detail="无法创建Google Ads客户端")
        
        client, _ = client_result
        cpc_micros = dollars_to_micros(request.cpc_amount)
        result = sync_service.set_keyword_cpc(
            client,
            request.customer_id,
            request.ad_group_id,
            request.criterion_id,
            cpc_micros
        )
        
        if result["success"]:
            # 更新本地记录
            keyword = db.query(KeywordBid).filter(
                KeywordBid.criterion_id == request.criterion_id
            ).first()
            if keyword:
                keyword.max_cpc = request.cpc_amount
                keyword.last_sync_at = datetime.utcnow()
                db.commit()
            
            return {
                "success": True,
                "message": f"CPC已设置为 {request.cpc_amount}"
            }
        else:
            raise HTTPException(status_code=500, detail=result["message"])
            
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/batch-set-cpc")
async def batch_set_keyword_cpc(
    request: BatchSetKeywordCpcRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """批量设置关键词CPC"""
    from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
    
    mcc = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.id == request.mcc_id,
        GoogleMccAccount.user_id == current_user.id
    ).first()
    
    if not mcc:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    try:
        sync_service = GoogleAdsServiceAccountSync(db)
        client_result = sync_service._create_client(mcc)
        
        if not client_result:
            raise HTTPException(status_code=500, detail="无法创建Google Ads客户端")
        
        client, _ = client_result
        results = []
        success_count = 0
        failed_count = 0
        
        for kw in request.keywords:
            cpc_micros = dollars_to_micros(kw["cpc_amount"])
            result = sync_service.set_keyword_cpc(
                client,
                request.customer_id,
                kw["ad_group_id"],
                kw["criterion_id"],
                cpc_micros
            )
            
            if result["success"]:
                success_count += 1
                # 更新本地记录
                keyword = db.query(KeywordBid).filter(
                    KeywordBid.criterion_id == kw["criterion_id"]
                ).first()
                if keyword:
                    keyword.max_cpc = kw["cpc_amount"]
                    keyword.last_sync_at = datetime.utcnow()
            else:
                failed_count += 1
            
            results.append({
                "criterion_id": kw["criterion_id"],
                "success": result["success"],
                "message": result["message"]
            })
        
        db.commit()
        
        return {
            "success": failed_count == 0,
            "message": f"成功 {success_count} 个，失败 {failed_count} 个",
            "results": results
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/campaign-max-cpc/{campaign_id}")
async def get_campaign_max_cpc(
    campaign_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取广告系列的最高CPC（取所有关键词的MAX）"""
    from sqlalchemy import func
    
    result = db.query(
        func.max(KeywordBid.max_cpc).label("max_cpc"),
        func.avg(KeywordBid.avg_cpc).label("avg_cpc"),
        func.count(KeywordBid.id).label("keyword_count")
    ).filter(
        KeywordBid.user_id == current_user.id,
        KeywordBid.campaign_id == campaign_id,
        KeywordBid.status == "ENABLED"
    ).first()
    
    # 获取出价策略
    strategy = db.query(CampaignBidStrategy).filter(
        CampaignBidStrategy.user_id == current_user.id,
        CampaignBidStrategy.campaign_id == campaign_id
    ).first()
    
    return {
        "campaign_id": campaign_id,
        "max_cpc": result.max_cpc if result else None,
        "avg_cpc": result.avg_cpc if result else None,
        "keyword_count": result.keyword_count if result else 0,
        "is_manual_cpc": strategy.is_manual_cpc if strategy else None,
        "bidding_strategy_type": strategy.bidding_strategy_type if strategy else None,
        "bidding_strategy_name": strategy.bidding_strategy_name if strategy else None,
    }


@router.post("/parse-suggestions")
async def parse_cpc_suggestions(
    request: ParseCpcSuggestionsRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    解析AI报告中的CPC调整建议
    从AI报告文本中提取JSON格式的cpc_adjustments
    """
    import json
    import re
    
    ai_report = request.ai_report
    
    # 尝试从报告中提取JSON块
    json_pattern = r'```json\s*([\s\S]*?)\s*```'
    matches = re.findall(json_pattern, ai_report)
    
    cpc_adjustments = []
    pause_campaigns = []
    budget_adjustments = []
    
    for match in matches:
        try:
            data = json.loads(match)
            if "cpc_adjustments" in data:
                cpc_adjustments.extend(data["cpc_adjustments"])
            if "pause_campaigns" in data:
                pause_campaigns.extend(data["pause_campaigns"])
            if "budget_adjustments" in data:
                budget_adjustments.extend(data["budget_adjustments"])
        except json.JSONDecodeError:
            continue
    
    # 为每个CPC调整查找对应的广告系列信息
    enriched_adjustments = []
    for adj in cpc_adjustments:
        campaign_name = adj.get("campaign_name", "")
        
        # 尝试在数据库中查找匹配的广告系列
        strategy = db.query(CampaignBidStrategy).filter(
            CampaignBidStrategy.user_id == current_user.id,
            CampaignBidStrategy.campaign_name.contains(campaign_name)
        ).first()
        
        enriched = {
            **adj,
            "found_in_db": strategy is not None,
            "db_campaign_id": strategy.campaign_id if strategy else None,
            "db_customer_id": strategy.customer_id if strategy else None,
            "db_mcc_id": strategy.mcc_id if strategy else None,
            "is_manual_cpc": strategy.is_manual_cpc if strategy else None,
            "bidding_strategy_type": strategy.bidding_strategy_type if strategy else None,
        }
        enriched_adjustments.append(enriched)
    
    # 为每个预算调整查找对应的广告系列信息
    enriched_budget_adjustments = []
    for adj in budget_adjustments:
        campaign_name = adj.get("campaign_name", "")
        
        # 尝试在数据库中查找匹配的广告系列
        strategy = db.query(CampaignBidStrategy).filter(
            CampaignBidStrategy.user_id == current_user.id,
            CampaignBidStrategy.campaign_name.contains(campaign_name)
        ).first()
        
        enriched = {
            **adj,
            "found_in_db": strategy is not None,
            "db_campaign_id": strategy.campaign_id if strategy else None,
            "db_customer_id": strategy.customer_id if strategy else None,
            "db_mcc_id": strategy.mcc_id if strategy else None,
            "current_budget": strategy.daily_budget if strategy else None,
        }
        enriched_budget_adjustments.append(enriched)
    
    return {
        "success": True,
        "cpc_adjustments": enriched_adjustments,
        "pause_campaigns": pause_campaigns,
        "budget_adjustments": enriched_budget_adjustments,
        "total_cpc_changes": len(enriched_adjustments),
        "total_pause": len(pause_campaigns),
        "total_budget_changes": len(enriched_budget_adjustments)
    }


@router.post("/preview-changes")
async def preview_cpc_changes(
    mcc_id: int,
    campaign_names: List[str],
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    预览CPC变更
    根据广告系列名称列表，返回可调整的关键词列表
    """
    from sqlalchemy import func
    
    result = []
    
    for campaign_name in campaign_names:
        # 查找广告系列
        strategy = db.query(CampaignBidStrategy).filter(
            CampaignBidStrategy.user_id == current_user.id,
            CampaignBidStrategy.mcc_id == mcc_id,
            CampaignBidStrategy.campaign_name.contains(campaign_name)
        ).first()
        
        if not strategy:
            result.append({
                "campaign_name": campaign_name,
                "found": False,
                "message": "未找到匹配的广告系列"
            })
            continue
        
        # 获取该广告系列下的关键词
        keywords = db.query(KeywordBid).filter(
            KeywordBid.user_id == current_user.id,
            KeywordBid.campaign_id == strategy.campaign_id,
            KeywordBid.status == "ENABLED"
        ).all()
        
        result.append({
            "campaign_name": strategy.campaign_name,
            "campaign_id": strategy.campaign_id,
            "customer_id": strategy.customer_id,
            "mcc_id": strategy.mcc_id,
            "found": True,
            "is_manual_cpc": strategy.is_manual_cpc,
            "bidding_strategy_type": strategy.bidding_strategy_type,
            "keywords": [{
                "criterion_id": k.criterion_id,
                "ad_group_id": k.ad_group_id,
                "keyword_text": k.keyword_text,
                "match_type": k.match_type,
                "current_cpc": k.max_cpc,
                "avg_cpc": k.avg_cpc
            } for k in keywords]
        })
    
    return {
        "success": True,
        "campaigns": result
    }


@router.post("/apply-cpc-changes")
async def apply_cpc_changes(
    request: ApplyCpcChangesRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    应用CPC变更到Google Ads
    批量修改多个广告系列的关键词CPC
    """
    from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
    
    mcc = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.id == request.mcc_id,
        GoogleMccAccount.user_id == current_user.id
    ).first()
    
    if not mcc:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    try:
        sync_service = GoogleAdsServiceAccountSync(db)
        client_result = sync_service._create_client(mcc)
        
        if not client_result:
            raise HTTPException(status_code=500, detail="无法创建Google Ads客户端")
        
        client, _ = client_result
        results = []
        success_count = 0
        failed_count = 0
        needs_manual_conversion = []
        
        for adj in request.adjustments:
            campaign_name = adj.get("campaign_name", "")
            campaign_id = adj.get("campaign_id", "")
            target_cpc = adj.get("target_cpc", 0)
            
            # 查找广告系列策略
            strategy = None
            if campaign_id:
                strategy = db.query(CampaignBidStrategy).filter(
                    CampaignBidStrategy.user_id == current_user.id,
                    CampaignBidStrategy.campaign_id == campaign_id
                ).first()
            else:
                strategy = db.query(CampaignBidStrategy).filter(
                    CampaignBidStrategy.user_id == current_user.id,
                    CampaignBidStrategy.campaign_name.contains(campaign_name)
                ).first()
            
            if not strategy:
                results.append({
                    "campaign_name": campaign_name,
                    "success": False,
                    "message": "未找到广告系列"
                })
                failed_count += 1
                continue
            
            # 检查是否是人工出价
            if not strategy.is_manual_cpc:
                needs_manual_conversion.append({
                    "campaign_name": strategy.campaign_name,
                    "campaign_id": strategy.campaign_id,
                    "customer_id": strategy.customer_id,
                    "bidding_strategy_type": strategy.bidding_strategy_type
                })
                results.append({
                    "campaign_name": strategy.campaign_name,
                    "success": False,
                    "message": f"需要先转为人工出价（当前: {strategy.bidding_strategy_type}）"
                })
                failed_count += 1
                continue
            
            # 获取该广告系列的关键词并批量更新CPC
            keywords = db.query(KeywordBid).filter(
                KeywordBid.user_id == current_user.id,
                KeywordBid.campaign_id == strategy.campaign_id,
                KeywordBid.status == "ENABLED"
            ).all()
            
            keyword_success = 0
            keyword_failed = 0
            
            for kw in keywords:
                cpc_micros = dollars_to_micros(target_cpc)
                result = sync_service.set_keyword_cpc(
                    client,
                    strategy.customer_id,
                    kw.ad_group_id,
                    kw.criterion_id,
                    cpc_micros
                )
                
                if result["success"]:
                    keyword_success += 1
                    kw.max_cpc = target_cpc
                    kw.last_sync_at = datetime.utcnow()
                else:
                    keyword_failed += 1
            
            db.commit()
            
            if keyword_failed == 0:
                success_count += 1
                results.append({
                    "campaign_name": strategy.campaign_name,
                    "success": True,
                    "message": f"已更新 {keyword_success} 个关键词的CPC为 ${target_cpc}"
                })
            else:
                failed_count += 1
                results.append({
                    "campaign_name": strategy.campaign_name,
                    "success": False,
                    "message": f"部分失败: {keyword_success} 成功, {keyword_failed} 失败"
                })
        
        return {
            "success": failed_count == 0,
            "message": f"处理完成: {success_count} 成功, {failed_count} 失败",
            "results": results,
            "needs_manual_conversion": needs_manual_conversion
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"应用CPC变更失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


class ToggleKeywordStatusRequest(BaseModel):
    mcc_id: int
    customer_id: str
    ad_group_id: str
    criterion_id: str
    new_status: str  # ENABLED or PAUSED


class AddKeywordRequest(BaseModel):
    mcc_id: int
    customer_id: str
    ad_group_id: str
    keyword_text: str
    match_type: str  # EXACT, PHRASE, BROAD
    cpc_bid_micros: Optional[int] = None


class UpdateKeywordRequest(BaseModel):
    mcc_id: int
    customer_id: str
    ad_group_id: str
    criterion_id: str
    keyword_text: Optional[str] = None
    match_type: Optional[str] = None
    cpc_bid_micros: Optional[int] = None


@router.post("/toggle-keyword-status")
async def toggle_keyword_status(
    request: ToggleKeywordStatusRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """暂停/启用关键词"""
    from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
    
    mcc = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.id == request.mcc_id,
        GoogleMccAccount.user_id == current_user.id
    ).first()
    
    if not mcc:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    try:
        sync_service = GoogleAdsServiceAccountSync(db)
        client_result = sync_service._create_client(mcc)
        
        if not client_result:
            raise HTTPException(status_code=500, detail="无法创建Google Ads客户端")
        
        client, _ = client_result
        result = sync_service.toggle_keyword_status(
            client,
            request.customer_id,
            request.ad_group_id,
            request.criterion_id,
            request.new_status
        )
        
        if result["success"]:
            # 更新本地记录
            keyword = db.query(KeywordBid).filter(
                KeywordBid.criterion_id == request.criterion_id
            ).first()
            if keyword:
                keyword.status = request.new_status
                db.commit()
            
            return {
                "success": True,
                "message": f"关键词已{'启用' if request.new_status == 'ENABLED' else '暂停'}"
            }
        else:
            raise HTTPException(status_code=500, detail=result["message"])
            
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/add-keyword")
async def add_keyword(
    request: AddKeywordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """添加关键词"""
    from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
    
    mcc = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.id == request.mcc_id,
        GoogleMccAccount.user_id == current_user.id
    ).first()
    
    if not mcc:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    try:
        sync_service = GoogleAdsServiceAccountSync(db)
        client_result = sync_service._create_client(mcc)
        
        if not client_result:
            raise HTTPException(status_code=500, detail="无法创建Google Ads客户端")
        
        client, _ = client_result
        result = sync_service.add_keyword(
            client,
            request.customer_id,
            request.ad_group_id,
            request.keyword_text,
            request.match_type,
            request.cpc_bid_micros
        )
        
        if result["success"]:
            return {
                "success": True,
                "message": f"关键词 '{request.keyword_text}' 添加成功",
                "criterion_id": result.get("criterion_id")
            }
        else:
            raise HTTPException(status_code=500, detail=result["message"])
            
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/update-keyword")
async def update_keyword(
    request: UpdateKeywordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """修改关键词（注意：Google Ads不支持直接修改关键词文本，需要删除后重新添加）"""
    from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
    
    mcc = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.id == request.mcc_id,
        GoogleMccAccount.user_id == current_user.id
    ).first()
    
    if not mcc:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    try:
        sync_service = GoogleAdsServiceAccountSync(db)
        client_result = sync_service._create_client(mcc)
        
        if not client_result:
            raise HTTPException(status_code=500, detail="无法创建Google Ads客户端")
        
        client, _ = client_result
        
        # 如果只是修改CPC，直接调用set_keyword_cpc
        if request.cpc_bid_micros and not request.keyword_text and not request.match_type:
            result = sync_service.set_keyword_cpc(
                client,
                request.customer_id,
                request.ad_group_id,
                request.criterion_id,
                request.cpc_bid_micros
            )
        else:
            # 修改关键词文本或匹配类型需要删除后重新添加
            # 先获取当前关键词信息
            keyword = db.query(KeywordBid).filter(
                KeywordBid.criterion_id == request.criterion_id
            ).first()
            
            if not keyword:
                raise HTTPException(status_code=404, detail="关键词不存在")
            
            # 删除旧关键词
            delete_result = sync_service.remove_keyword(
                client,
                request.customer_id,
                request.ad_group_id,
                request.criterion_id
            )
            
            if not delete_result["success"]:
                raise HTTPException(status_code=500, detail=f"删除旧关键词失败: {delete_result['message']}")
            
            # 添加新关键词
            new_keyword_text = request.keyword_text or keyword.keyword_text
            new_match_type = request.match_type or keyword.match_type
            new_cpc = request.cpc_bid_micros or (dollars_to_micros(keyword.max_cpc) if keyword.max_cpc else None)
            
            result = sync_service.add_keyword(
                client,
                request.customer_id,
                request.ad_group_id,
                new_keyword_text,
                new_match_type,
                new_cpc
            )
            
            if result["success"]:
                # 删除本地旧记录
                db.delete(keyword)
                db.commit()
        
        if result["success"]:
            return {
                "success": True,
                "message": "关键词修改成功"
            }
        else:
            raise HTTPException(status_code=500, detail=result["message"])
            
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/ad-groups")
async def get_ad_groups(
    mcc_id: int,
    campaign_id: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取广告组列表（用于添加关键词时选择）"""
    from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
    
    mcc = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.id == mcc_id,
        GoogleMccAccount.user_id == current_user.id
    ).first()
    
    if not mcc:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    try:
        sync_service = GoogleAdsServiceAccountSync(db)
        client_result = sync_service._create_client(mcc)
        
        if not client_result:
            raise HTTPException(status_code=500, detail="无法创建Google Ads客户端")
        
        client, mcc_customer_id = client_result
        
        # 获取客户账号列表
        customers = sync_service.get_accessible_customers(client, mcc_customer_id)
        
        all_ad_groups = []
        for customer in customers:
            customer_id = customer["id"]
            ad_groups = sync_service.fetch_ad_groups(client, customer_id, campaign_id)
            all_ad_groups.extend(ad_groups)
        
        return all_ad_groups
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ============ 预算管理 API ============

class SetBudgetRequest(BaseModel):
    mcc_id: int
    customer_id: str
    campaign_id: str
    new_budget: float  # 新的每日预算（美元）


class BatchSetBudgetRequest(BaseModel):
    mcc_id: int
    customer_id: str
    campaigns: List[dict]  # [{"campaign_id": "xxx", "new_budget": 50.0}]


@router.get("/campaign-budget/{mcc_id}/{customer_id}/{campaign_id}")
async def get_campaign_budget(
    mcc_id: int,
    customer_id: str,
    campaign_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取广告系列的当前预算"""
    mcc = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.id == mcc_id,
        GoogleMccAccount.user_id == current_user.id
    ).first()
    
    if not mcc:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    try:
        sync_service = GoogleAdsServiceAccountSync(db)
        client_result = sync_service._create_client(mcc)
        
        if not client_result:
            raise HTTPException(status_code=500, detail="无法创建Google Ads客户端")
        
        client, _ = client_result
        result = sync_service.get_campaign_budget(client, customer_id, campaign_id)
        
        if not result["success"]:
            raise HTTPException(status_code=400, detail=result["message"])
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/set-budget")
async def set_campaign_budget(
    request: SetBudgetRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """设置广告系列的每日预算"""
    mcc = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.id == request.mcc_id,
        GoogleMccAccount.user_id == current_user.id
    ).first()
    
    if not mcc:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    try:
        sync_service = GoogleAdsServiceAccountSync(db)
        client_result = sync_service._create_client(mcc)
        
        if not client_result:
            raise HTTPException(status_code=500, detail="无法创建Google Ads客户端")
        
        client, _ = client_result
        
        # 先获取当前预算信息（包括budget_id）
        budget_info = sync_service.get_campaign_budget(client, request.customer_id, request.campaign_id)
        if not budget_info["success"]:
            raise HTTPException(status_code=400, detail=f"获取预算信息失败: {budget_info['message']}")
        
        budget_id = budget_info["budget_id"]
        new_budget_micros = dollars_to_micros(request.new_budget)
        
        # 设置新预算
        result = sync_service.set_campaign_budget(client, request.customer_id, budget_id, new_budget_micros)
        
        if not result["success"]:
            raise HTTPException(status_code=400, detail=result["message"])
        
        # 更新本地数据库中的记录（如果有）
        strategy = db.query(CampaignBidStrategy).filter(
            CampaignBidStrategy.campaign_id == request.campaign_id,
            CampaignBidStrategy.mcc_id == request.mcc_id
        ).first()
        
        if strategy:
            # 如果模型有daily_budget字段，更新它
            if hasattr(strategy, 'daily_budget'):
                strategy.daily_budget = request.new_budget
                strategy.updated_at = datetime.utcnow()
                db.commit()
        
        return {
            "success": True,
            "message": f"每日预算已设置为 ${request.new_budget:.2f}",
            "campaign_id": request.campaign_id,
            "new_budget": request.new_budget
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/batch-set-budget")
async def batch_set_campaign_budget(
    request: BatchSetBudgetRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """批量设置广告系列的每日预算"""
    mcc = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.id == request.mcc_id,
        GoogleMccAccount.user_id == current_user.id
    ).first()
    
    if not mcc:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    try:
        sync_service = GoogleAdsServiceAccountSync(db)
        client_result = sync_service._create_client(mcc)
        
        if not client_result:
            raise HTTPException(status_code=500, detail="无法创建Google Ads客户端")
        
        client, _ = client_result
        
        results = []
        success_count = 0
        
        for campaign in request.campaigns:
            campaign_id = campaign.get("campaign_id")
            new_budget = campaign.get("new_budget")
            
            if not campaign_id or new_budget is None:
                results.append({
                    "campaign_id": campaign_id,
                    "success": False,
                    "message": "缺少campaign_id或new_budget"
                })
                continue
            
            try:
                # 获取预算ID
                budget_info = sync_service.get_campaign_budget(client, request.customer_id, campaign_id)
                if not budget_info["success"]:
                    results.append({
                        "campaign_id": campaign_id,
                        "success": False,
                        "message": budget_info["message"]
                    })
                    continue
                
                budget_id = budget_info["budget_id"]
                new_budget_micros = dollars_to_micros(new_budget)
                
                # 设置预算
                result = sync_service.set_campaign_budget(client, request.customer_id, budget_id, new_budget_micros)
                
                if result["success"]:
                    success_count += 1
                    results.append({
                        "campaign_id": campaign_id,
                        "success": True,
                        "new_budget": new_budget
                    })
                else:
                    results.append({
                        "campaign_id": campaign_id,
                        "success": False,
                        "message": result["message"]
                    })
                    
            except Exception as e:
                results.append({
                    "campaign_id": campaign_id,
                    "success": False,
                    "message": str(e)
                })
        
        return {
            "success": True,
            "message": f"批量设置完成: {success_count}/{len(request.campaigns)} 个成功",
            "results": results
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/one-click-deploy")
async def one_click_deploy(
    request: OneClickDeployRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    一键部署CPC和预算修改
    
    接收前端确认后的部署请求，批量执行：
    1. 关键词CPC修改
    2. 广告系列预算修改
    """
    from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
    
    results = []
    total_keywords_success = 0
    total_keywords_failed = 0
    total_budget_success = 0
    total_budget_failed = 0
    
    # 按 mcc_id 分组处理
    mcc_campaigns = {}
    for campaign in request.campaigns:
        mcc_id = campaign.mcc_id
        if mcc_id not in mcc_campaigns:
            mcc_campaigns[mcc_id] = []
        mcc_campaigns[mcc_id].append(campaign)
    
    for mcc_id, campaigns in mcc_campaigns.items():
        # 获取MCC账号
        mcc = db.query(GoogleMccAccount).filter(
            GoogleMccAccount.id == mcc_id,
            GoogleMccAccount.user_id == current_user.id
        ).first()
        
        if not mcc:
            for campaign in campaigns:
                results.append({
                    "campaign_name": campaign.campaign_name,
                    "success": False,
                    "message": f"MCC账号 {mcc_id} 不存在"
                })
            continue
        
        try:
            sync_service = GoogleAdsServiceAccountSync(db)
            client_result = sync_service._create_client(mcc)
            
            if not client_result:
                for campaign in campaigns:
                    results.append({
                        "campaign_name": campaign.campaign_name,
                        "success": False,
                        "message": "无法创建Google Ads客户端"
                    })
                continue
            
            client, _ = client_result
            
            for campaign in campaigns:
                campaign_result = {
                    "campaign_name": campaign.campaign_name,
                    "keyword_results": [],
                    "budget_result": None
                }
                
                customer_id = campaign.customer_id
                
                # 1. 处理关键词CPC修改
                for kw in campaign.keywords:
                    if not kw.selected:
                        continue
                    
                    try:
                        cpc_micros = dollars_to_micros(kw.target_cpc)
                        result = sync_service.set_keyword_cpc(
                            client,
                            customer_id,
                            kw.ad_group_id,
                            kw.keyword_id,
                            cpc_micros
                        )
                        
                        if result["success"]:
                            total_keywords_success += 1
                            campaign_result["keyword_results"].append({
                                "keyword_text": kw.keyword_text,
                                "success": True,
                                "new_cpc": kw.target_cpc
                            })
                            
                            # 更新数据库
                            db_kw = db.query(KeywordBid).filter(
                                KeywordBid.criterion_id == kw.keyword_id,
                                KeywordBid.user_id == current_user.id
                            ).first()
                            if db_kw:
                                db_kw.max_cpc = kw.target_cpc
                                db_kw.last_sync_at = datetime.utcnow()
                        else:
                            total_keywords_failed += 1
                            campaign_result["keyword_results"].append({
                                "keyword_text": kw.keyword_text,
                                "success": False,
                                "message": result.get("message", "未知错误")
                            })
                    except Exception as e:
                        total_keywords_failed += 1
                        campaign_result["keyword_results"].append({
                            "keyword_text": kw.keyword_text,
                            "success": False,
                            "message": str(e)
                        })
                
                # 2. 处理预算修改
                if campaign.budget_selected and campaign.budget_target and campaign.budget_target > 0:
                    try:
                        # 获取预算ID
                        budget_info = sync_service.get_campaign_budget_id(
                            client, customer_id, campaign.campaign_id
                        )
                        
                        if budget_info and budget_info.get("budget_id"):
                            budget_id = budget_info["budget_id"]
                            budget_micros = dollars_to_micros(campaign.budget_target)
                            
                            result = sync_service.set_campaign_budget(
                                client, customer_id, budget_id, budget_micros
                            )
                            
                            if result["success"]:
                                total_budget_success += 1
                                campaign_result["budget_result"] = {
                                    "success": True,
                                    "new_budget": campaign.budget_target
                                }
                            else:
                                total_budget_failed += 1
                                campaign_result["budget_result"] = {
                                    "success": False,
                                    "message": result.get("message", "未知错误")
                                }
                        else:
                            total_budget_failed += 1
                            campaign_result["budget_result"] = {
                                "success": False,
                                "message": "无法获取预算ID"
                            }
                    except Exception as e:
                        total_budget_failed += 1
                        campaign_result["budget_result"] = {
                            "success": False,
                            "message": str(e)
                        }
                
                results.append(campaign_result)
                db.commit()
                
        except Exception as e:
            for campaign in campaigns:
                results.append({
                    "campaign_name": campaign.campaign_name,
                    "success": False,
                    "message": str(e)
                })
    
    return {
        "success": True,
        "summary": {
            "keywords_success": total_keywords_success,
            "keywords_failed": total_keywords_failed,
            "budget_success": total_budget_success,
            "budget_failed": total_budget_failed
        },
        "results": results
    }


@router.post("/get-keyword-suggestions")
async def get_keyword_suggestions(
    campaign_name: str,
    conservative_epc: float,
    is_rank_lost: float = 0,
    current_budget: float = 0,
    conservative_roi: float = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    获取广告系列的关键词CPC建议
    
    用于前端显示部署预览
    """
    from app.services.cpc_deployment_service import CPCDeploymentService
    
    service = CPCDeploymentService(db)
    suggestions = service.calculate_keyword_cpc_suggestions(
        user_id=current_user.id,
        campaign_name=campaign_name,
        conservative_epc=conservative_epc,
        is_rank_lost=is_rank_lost,
        current_budget=current_budget,
        conservative_roi=conservative_roi
    )
    
    return suggestions

