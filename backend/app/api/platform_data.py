"""
平台数据API（8平台统一方案）
使用affiliate_transactions表，按日期+平台+商户聚合
支持汇总模式和明细模式
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, and_, case
from typing import Optional, List
from datetime import date, datetime
from pydantic import BaseModel
import logging

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.affiliate_transaction import AffiliateTransaction

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/platform-data", tags=["platform-data"])


class PlatformDataDetailResponse(BaseModel):
    """平台数据明细响应（按日期+平台+商户聚合）"""
    date: str
    platform: str
    merchant: Optional[str]
    total_orders: int
    gmv: float
    total_commission: float  # 总佣金（所有状态，对应Est. Commission）
    approved_commission: float  # 已确认佣金（保留用于兼容）
    rejected_commission: float
    rejected_rate: float
    net_commission: float


class PlatformDataSummaryResponse(BaseModel):
    """平台数据汇总响应（时间范围级别聚合）"""
    date_range_label: str
    begin_date: date
    end_date: date
    total_orders: int
    total_gmv: float
    total_commission: float  # 总佣金（所有状态，对应Est. Commission）
    total_approved_commission: float  # 已确认佣金（保留用于兼容）
    total_rejected_commission: float
    total_rejected_rate: float
    total_net_commission: float
    merchant_breakdown: List[dict]  # 按商家聚合（MID、商家、订单数、销售额、佣金）
    platform_breakdown: List[dict]  # 按平台分组的数据（保留用于兼容）


@router.get("/detail", response_model=List[PlatformDataDetailResponse])
async def get_platform_data_detail(
    begin_date: str = Query(..., description="开始日期 YYYY-MM-DD"),
    end_date: str = Query(..., description="结束日期 YYYY-MM-DD"),
    platform: Optional[str] = Query(None, description="平台代码（可选）"),
    merchant: Optional[str] = Query(None, description="商户名称（可选，支持模糊匹配）"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    获取平台数据明细（按日期+平台+商户聚合）
    
    返回每天每个平台每个商户的汇总数据
    """
    try:
        # 解析日期
        begin = datetime.strptime(begin_date, "%Y-%m-%d").date()
        end = datetime.strptime(end_date, "%Y-%m-%d").date()
        begin_datetime = datetime.combine(begin, datetime.min.time())
        end_datetime = datetime.combine(end, datetime.max.time())
        
        # 基础查询：按日期+平台+商户聚合
        # SQLite使用date()函数提取日期
        from sqlalchemy import func as sql_func
        query = db.query(
            func.date(AffiliateTransaction.transaction_time).label('date'),
            AffiliateTransaction.platform,
            AffiliateTransaction.merchant,
            func.count(AffiliateTransaction.id).label('total_orders'),
            func.sum(AffiliateTransaction.order_amount).label('gmv'),
            func.sum(AffiliateTransaction.commission_amount).label('total_commission'),  # 总佣金（所有状态）
            func.sum(
                case(
                    (AffiliateTransaction.status == "approved", AffiliateTransaction.commission_amount),
                    else_=0
                )
            ).label('approved_commission'),
            func.sum(
                case(
                    (AffiliateTransaction.status == "rejected", AffiliateTransaction.commission_amount),
                    else_=0
                )
            ).label('rejected_commission')
        ).filter(
            AffiliateTransaction.transaction_time >= begin_datetime,
            AffiliateTransaction.transaction_time <= end_datetime
        )
        
        # 权限控制：员工只能看自己的数据
        if current_user.role == "employee":
            query = query.filter(AffiliateTransaction.user_id == current_user.id)
        
        # 筛选条件
        if platform:
            # 统一转换为小写，因为数据库中存储的是小写（如 'rw', 'cg', 'linkhaitao'）
            platform_lower = platform.lower().strip()
            
            # 平台代码别名映射（前端可能传递缩写、全称或URL，但数据库中存储的是标准格式）
            platform_code_map = {
                # CG (CollabGlow)
                'cg': 'cg',
                'collabglow': 'cg',
                'collab-glow': 'cg',
                'https://www.collabglow.com': 'cg',
                'https://www.collabglow.com/': 'cg',
                # RW (Rewardoo)
                'rw': 'rw',
                'rewardoo': 'rw',
                'reward-oo': 'rw',
                'https://www.rewardoo.com': 'rw',
                'https://www.rewardoo.com/': 'rw',
                # LinkHaitao
                'lh': 'linkhaitao',
                'linkhaitao': 'linkhaitao',
                'link-haitao': 'linkhaitao',
                'link_haitao': 'linkhaitao',
                'https://www.linkhaitao.com': 'linkhaitao',
                'https://www.linkhaitao.com/': 'linkhaitao',
                # PartnerBoost
                'pb': 'partnerboost',
                'partnerboost': 'partnerboost',
                'partner-boost': 'partnerboost',
                # Linkbux
                'lb': 'linkbux',
                'linkbux': 'linkbux',
                'link-bux': 'linkbux',
                # Partnermatic
                'pm': 'partnermatic',
                'partnermatic': 'partnermatic',
                'partner-matic': 'partnermatic',
                # BrandSparkHub
                'bsh': 'brandsparkhub',
                'brandsparkhub': 'brandsparkhub',
                'brand-spark-hub': 'brandsparkhub',
                # CreatorFlare
                'cf': 'creatorflare',
                'creatorflare': 'creatorflare',
                'creator-flare': 'creatorflare',
            }
            
            # 如果存在映射，使用映射后的值；否则尝试从URL中提取域名
            platform_final = platform_code_map.get(platform_lower, platform_lower)
            
            # 如果仍然不匹配，尝试从URL中提取平台代码
            if platform_final == platform_lower and ('http://' in platform_lower or 'https://' in platform_lower):
                # 从URL中提取域名
                import re
                domain_match = re.search(r'://([^/]+)', platform_lower)
                if domain_match:
                    domain = domain_match.group(1).lower()
                    # 尝试匹配域名
                    if 'linkhaitao' in domain:
                        platform_final = 'linkhaitao'
                    elif 'rewardoo' in domain:
                        platform_final = 'rw'
                    elif 'collabglow' in domain:
                        platform_final = 'cg'
                    elif 'linkbux' in domain:
                        platform_final = 'linkbux'
                    elif 'partnermatic' in domain:
                        platform_final = 'partnermatic'
                    elif 'partnerboost' in domain:
                        platform_final = 'partnerboost'
                    elif 'brandsparkhub' in domain:
                        platform_final = 'brandsparkhub'
                    elif 'creatorflare' in domain:
                        platform_final = 'creatorflare'
            
            query = query.filter(AffiliateTransaction.platform == platform_final)
        
        if merchant:
            query = query.filter(AffiliateTransaction.merchant.like(f"%{merchant}%"))
        
        # 按日期+平台+商户分组
        query = query.group_by(
            func.date(AffiliateTransaction.transaction_time),
            AffiliateTransaction.platform,
            AffiliateTransaction.merchant
        )
        
        # 按日期倒序，平台、商户排序
        query = query.order_by(
            func.date(AffiliateTransaction.transaction_time).desc(),
            AffiliateTransaction.platform,
            AffiliateTransaction.merchant
        )
        
        results = query.all()
        
        # 转换为响应格式
        response_data = []
        for r in results:
            total_orders = int(r.total_orders or 0)
            gmv = float(r.gmv or 0)
            total_commission = float(r.total_commission or 0)  # 总佣金（所有状态，对应Est. Commission）
            approved_commission = float(r.approved_commission or 0)
            rejected_commission = float(r.rejected_commission or 0)
            # 拒付率基于总佣金计算（效仿CollabGlow）
            rejected_rate = (rejected_commission / total_commission * 100) if total_commission > 0 else 0
            net_commission = total_commission - rejected_commission  # 净佣金 = 总佣金 - 拒付佣金
            
            # 处理日期：r.date可能是字符串（SQLite date()函数返回字符串）或date对象
            date_str = r.date
            if isinstance(date_str, date):
                date_str = date_str.isoformat()
            elif isinstance(date_str, datetime):
                date_str = date_str.date().isoformat()
            elif not isinstance(date_str, str):
                date_str = str(date_str)
            
            response_data.append({
                "date": date_str,
                "platform": r.platform,
                "merchant": r.merchant,
                "total_orders": total_orders,
                "gmv": round(gmv, 2),
                "total_commission": round(total_commission, 2),  # 总佣金（对应Est. Commission）
                "approved_commission": round(approved_commission, 2),  # 保留用于兼容
                "rejected_commission": round(rejected_commission, 2),
                "rejected_rate": round(rejected_rate, 2),
                "net_commission": round(net_commission, 2)
            })
        
        return response_data
        
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"日期格式错误: {str(e)}")
    except Exception as e:
        logger.error(f"获取平台数据明细失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"查询失败: {str(e)}")


@router.get("/summary", response_model=PlatformDataSummaryResponse)
async def get_platform_data_summary(
    begin_date: str = Query(..., description="开始日期 YYYY-MM-DD"),
    end_date: str = Query(..., description="结束日期 YYYY-MM-DD"),
    platform: Optional[str] = Query(None, description="平台代码（可选）"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    获取平台数据汇总（时间范围级别聚合）
    
    返回整个时间范围的汇总数据，并按平台分组
    """
    try:
        # 解析日期
        begin = datetime.strptime(begin_date, "%Y-%m-%d").date()
        end = datetime.strptime(end_date, "%Y-%m-%d").date()
        begin_datetime = datetime.combine(begin, datetime.min.time())
        end_datetime = datetime.combine(end, datetime.max.time())
        
        # 基础查询
        base_query = db.query(AffiliateTransaction).filter(
            AffiliateTransaction.transaction_time >= begin_datetime,
            AffiliateTransaction.transaction_time <= end_datetime
        )
        
        # 权限控制
        if current_user.role == "employee":
            base_query = base_query.filter(AffiliateTransaction.user_id == current_user.id)
        
        # 平台筛选
        if platform:
            # 统一转换为小写，因为数据库中存储的是小写（如 'rw', 'cg', 'linkhaitao'）
            platform_lower = platform.lower().strip()
            
            # 平台代码别名映射（前端可能传递缩写、全称或URL，但数据库中存储的是标准格式）
            platform_code_map = {
                # CG (CollabGlow)
                'cg': 'cg',
                'collabglow': 'cg',
                'collab-glow': 'cg',
                'https://www.collabglow.com': 'cg',
                'https://www.collabglow.com/': 'cg',
                # RW (Rewardoo)
                'rw': 'rw',
                'rewardoo': 'rw',
                'reward-oo': 'rw',
                'https://www.rewardoo.com': 'rw',
                'https://www.rewardoo.com/': 'rw',
                # LinkHaitao
                'lh': 'linkhaitao',
                'linkhaitao': 'linkhaitao',
                'link-haitao': 'linkhaitao',
                'link_haitao': 'linkhaitao',
                'https://www.linkhaitao.com': 'linkhaitao',
                'https://www.linkhaitao.com/': 'linkhaitao',
                # PartnerBoost
                'pb': 'partnerboost',
                'partnerboost': 'partnerboost',
                'partner-boost': 'partnerboost',
                # Linkbux
                'lb': 'linkbux',
                'linkbux': 'linkbux',
                'link-bux': 'linkbux',
                # Partnermatic
                'pm': 'partnermatic',
                'partnermatic': 'partnermatic',
                'partner-matic': 'partnermatic',
                # BrandSparkHub
                'bsh': 'brandsparkhub',
                'brandsparkhub': 'brandsparkhub',
                'brand-spark-hub': 'brandsparkhub',
                # CreatorFlare
                'cf': 'creatorflare',
                'creatorflare': 'creatorflare',
                'creator-flare': 'creatorflare',
            }
            
            # 如果存在映射，使用映射后的值；否则尝试从URL中提取域名
            platform_final = platform_code_map.get(platform_lower, platform_lower)
            
            # 如果仍然不匹配，尝试从URL中提取平台代码
            if platform_final == platform_lower and ('http://' in platform_lower or 'https://' in platform_lower):
                # 从URL中提取域名
                import re
                domain_match = re.search(r'://([^/]+)', platform_lower)
                if domain_match:
                    domain = domain_match.group(1).lower()
                    # 尝试匹配域名
                    if 'linkhaitao' in domain:
                        platform_final = 'linkhaitao'
                    elif 'rewardoo' in domain:
                        platform_final = 'rw'
                    elif 'collabglow' in domain:
                        platform_final = 'cg'
                    elif 'linkbux' in domain:
                        platform_final = 'linkbux'
                    elif 'partnermatic' in domain:
                        platform_final = 'partnermatic'
                    elif 'partnerboost' in domain:
                        platform_final = 'partnerboost'
                    elif 'brandsparkhub' in domain:
                        platform_final = 'brandsparkhub'
                    elif 'creatorflare' in domain:
                        platform_final = 'creatorflare'
            
            base_query = base_query.filter(AffiliateTransaction.platform == platform_final)
        
        # 总体汇总
        total_query = base_query.with_entities(
            func.count(AffiliateTransaction.id).label('total_orders'),
            func.sum(AffiliateTransaction.order_amount).label('gmv'),
            func.sum(AffiliateTransaction.commission_amount).label('total_commission'),  # 总佣金（所有状态）
            func.sum(
                case(
                    (AffiliateTransaction.status == "approved", AffiliateTransaction.commission_amount),
                    else_=0
                )
            ).label('approved_commission'),
            func.sum(
                case(
                    (AffiliateTransaction.status == "rejected", AffiliateTransaction.commission_amount),
                    else_=0
                )
            ).label('rejected_commission')
        )
        total_result = total_query.first()
        
        total_orders = int(total_result.total_orders or 0)
        total_gmv = float(total_result.gmv or 0)
        total_commission = float(total_result.total_commission or 0)  # 总佣金（所有状态）
        total_approved_commission = float(total_result.approved_commission or 0)
        total_rejected_commission = float(total_result.rejected_commission or 0)
        # 拒付率基于总佣金计算（效仿CollabGlow）
        total_rejected_rate = (total_rejected_commission / total_commission * 100) if total_commission > 0 else 0
        total_net_commission = total_commission - total_rejected_commission  # 净佣金 = 总佣金 - 拒付佣金
        
        # 按平台+商家聚合（汇总模式：MID、商家、订单数、销售额、佣金）
        merchant_query = base_query.with_entities(
            AffiliateTransaction.platform,
            AffiliateTransaction.merchant,
            func.count(AffiliateTransaction.id).label('orders'),
            func.sum(AffiliateTransaction.order_amount).label('gmv'),
            func.sum(AffiliateTransaction.commission_amount).label('total_commission')  # 总佣金（所有状态）
        ).group_by(
            AffiliateTransaction.platform,
            AffiliateTransaction.merchant
        ).order_by(
            AffiliateTransaction.platform,
            func.sum(AffiliateTransaction.commission_amount).desc()
        )
        
        merchant_results = merchant_query.all()
        
        # 尝试从广告系列名中提取MID（从GoogleAdsApiData中查找）
        from app.models.google_ads_api_data import GoogleAdsApiData
        from app.models.ad_campaign import AdCampaign
        
        merchant_breakdown = []
        for r in merchant_results:
            orders = int(r.orders or 0)
            gmv = float(r.gmv or 0)
            total_comm = float(r.total_commission or 0)
            
            # 尝试查找MID：从GoogleAdsApiData中查找匹配的广告系列，提取MID
            mid = None
            if r.merchant:
                # 查找该平台该商家的广告系列，从广告系列名中提取MID
                # 格式：序号-平台-商家-投放国家-投放时间-MID
                ga_data = db.query(GoogleAdsApiData).filter(
                    GoogleAdsApiData.user_id == current_user.id if current_user.role == "employee" else True,
                    GoogleAdsApiData.extracted_platform_code == r.platform,
                    GoogleAdsApiData.date >= begin,
                    GoogleAdsApiData.date <= end,
                    GoogleAdsApiData.campaign_name.contains(r.merchant)
                ).first()
                
                if ga_data and ga_data.campaign_name:
                    # 从广告系列名提取MID（最后一个字段）
                    parts = ga_data.campaign_name.split('-')
                    if len(parts) >= 6:  # 序号-平台-商家-国家-时间-MID
                        mid = parts[-1]  # 最后一个字段是MID
            
            merchant_breakdown.append({
                "mid": mid or "",
                "merchant": r.merchant or "",
                "platform": r.platform,
                "orders": orders,
                "gmv": round(gmv, 2),
                "total_commission": round(total_comm, 2)
            })
        
        # 按平台分组汇总（保留用于兼容）
        platform_query = base_query.with_entities(
            AffiliateTransaction.platform,
            func.count(AffiliateTransaction.id).label('orders'),
            func.sum(AffiliateTransaction.order_amount).label('gmv'),
            func.sum(AffiliateTransaction.commission_amount).label('total_commission'),  # 总佣金（所有状态）
            func.sum(
                case(
                    (AffiliateTransaction.status == "approved", AffiliateTransaction.commission_amount),
                    else_=0
                )
            ).label('approved_commission'),
            func.sum(
                case(
                    (AffiliateTransaction.status == "rejected", AffiliateTransaction.commission_amount),
                    else_=0
                )
            ).label('rejected_commission')
        ).group_by(AffiliateTransaction.platform)
        
        platform_results = platform_query.all()
        
        platform_breakdown = []
        for r in platform_results:
            orders = int(r.orders or 0)
            gmv = float(r.gmv or 0)
            total_comm = float(r.total_commission or 0)  # 总佣金
            approved = float(r.approved_commission or 0)
            rejected = float(r.rejected_commission or 0)
            rejected_rate = (rejected / total_comm * 100) if total_comm > 0 else 0  # 基于总佣金计算
            net = total_comm - rejected  # 净佣金 = 总佣金 - 拒付佣金
            
            platform_breakdown.append({
                "platform": r.platform,
                "orders": orders,
                "gmv": round(gmv, 2),
                "total_commission": round(total_comm, 2),  # 总佣金
                "approved_commission": round(approved, 2),  # 保留用于兼容
                "rejected_commission": round(rejected, 2),
                "rejected_rate": round(rejected_rate, 2),
                "net_commission": round(net, 2)
            })
        
        # 生成日期范围标签
        if begin == end:
            date_range_label = begin.strftime("%Y-%m-%d")
        else:
            date_range_label = f"{begin.strftime('%Y-%m-%d')} ~ {end.strftime('%Y-%m-%d')}"
        
        return {
            "date_range_label": date_range_label,
            "begin_date": begin,
            "end_date": end,
            "total_orders": total_orders,
            "total_gmv": round(total_gmv, 2),
            "total_commission": round(total_commission, 2),  # 总佣金（对应Est. Commission）
            "total_approved_commission": round(total_approved_commission, 2),  # 保留用于兼容
            "total_rejected_commission": round(total_rejected_commission, 2),
            "total_rejected_rate": round(total_rejected_rate, 2),
            "total_net_commission": round(total_net_commission, 2),
            "merchant_breakdown": merchant_breakdown,  # 按商家聚合（MID、商家、订单数、销售额、佣金）
            "platform_breakdown": platform_breakdown  # 按平台聚合（保留用于兼容）
        }
        
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"日期格式错误: {str(e)}")
    except Exception as e:
        logger.error(f"获取平台数据汇总失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"查询失败: {str(e)}")


@router.get("/", response_model=List[PlatformDataDetailResponse])
async def get_platform_data(
    begin_date: str = Query(..., description="开始日期 YYYY-MM-DD"),
    end_date: str = Query(..., description="结束日期 YYYY-MM-DD"),
    platform: Optional[str] = Query(None, description="平台代码（可选）"),
    merchant: Optional[str] = Query(None, description="商户名称（可选）"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    获取平台数据（默认返回明细模式）
    
    兼容旧接口，实际调用明细接口
    """
    return await get_platform_data_detail(
        begin_date=begin_date,
        end_date=end_date,
        platform=platform,
        merchant=merchant,
        current_user=current_user,
        db=db
    )


