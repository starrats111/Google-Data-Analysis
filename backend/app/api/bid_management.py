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
        cpc_ceiling = int(request.cpc_bid_ceiling * 1_000_000) if request.cpc_bid_ceiling else None
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
        cpc_micros = int(request.cpc_amount * 1_000_000)
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
            cpc_micros = int(kw["cpc_amount"] * 1_000_000)
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
    
    return {
        "success": True,
        "cpc_adjustments": enriched_adjustments,
        "pause_campaigns": pause_campaigns,
        "budget_adjustments": budget_adjustments,
        "total_cpc_changes": len(enriched_adjustments),
        "total_pause": len(pause_campaigns),
        "total_budget_changes": len(budget_adjustments)
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
                cpc_micros = int(target_cpc * 1_000_000)
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


