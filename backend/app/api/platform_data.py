"""
平台数据API（8平台统一方案）
使用affiliate_transactions表，按日期+平台+商户聚合
支持汇总模式和明细模式
"""
from fastapi import APIRouter, Depends, HTTPException, Query, BackgroundTasks
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
from app.models.affiliate_account import AffiliateAccount

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


class MerchantBreakdownItem(BaseModel):
    """商家聚合数据项"""
    mid: str
    merchant: str
    platform: str
    account_label: Optional[str] = None  # 账号标签，如 "RW-1"、"RW-2"，无序号时为 "RW"
    orders: int
    gmv: float
    total_commission: float  # 总佣金（所有状态，对应Est. Commission）
    approved_commission: float  # 已付佣金
    pending_commission: float  # 审核佣金
    rejected_commission: float  # 拒付佣金


class AccountBreakdownItem(BaseModel):
    """账号聚合数据项（用于筛选器）"""
    account_label: str  # 账号标签，如 "RW-1"、"RW-2"
    platform: str
    account_id: int
    orders: int
    total_commission: float


class PlatformDataSummaryResponse(BaseModel):
    """平台数据汇总响应（时间范围级别聚合）"""
    date_range_label: str
    begin_date: date
    end_date: date
    total_orders: int
    total_gmv: float
    total_commission: float  # 总佣金（所有状态，对应Est. Commission）
    total_approved_commission: float  # 已付佣金
    total_pending_commission: float  # 审核佣金
    total_rejected_commission: float  # 拒付佣金
    total_rejected_rate: float
    total_net_commission: float
    merchant_breakdown: List[MerchantBreakdownItem]  # 按商家聚合（MID、商家、订单数、销售额、佣金）
    platform_breakdown: List[dict]  # 按平台分组的数据（保留用于兼容）
    account_breakdown: Optional[List[AccountBreakdownItem]] = None  # 按账号分组（用于筛选器）


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
        # 排除已删除/停用账号的交易
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
        ).outerjoin(
            AffiliateAccount,
            AffiliateTransaction.affiliate_account_id == AffiliateAccount.id
        ).filter(
            AffiliateTransaction.transaction_time >= begin_datetime,
            AffiliateTransaction.transaction_time <= end_datetime,
            # 排除已停用账号的交易
            (AffiliateAccount.id.is_(None)) | (AffiliateAccount.is_active == True)
        )
        
        # 权限控制：员工只能看自己的数据
        if current_user.role in ("employee", "member", "leader"):
            query = query.filter(AffiliateTransaction.user_id == current_user.id)
        
        # 筛选条件
        if platform:
            # 统一转换为小写，因为数据库中存储的是小写（如 'rw', 'cg', 'linkhaitao'）
            platform_lower = platform.lower().strip()
            
            # 平台代码别名映射（前端可能传递缩写、全称或URL，数据库统一存储小写缩写）
            platform_code_map = {
                # CG (CollabGlow)
                'cg': 'cg',
                'collabglow': 'cg',
                'collab-glow': 'cg',
                'https://www.collabglow.com': 'cg',
                'https://www.collabglow.com/': 'cg',
                'https://app.collabglow.com': 'cg',
                'https://app.collabglow.com/': 'cg',
                # RW (Rewardoo)
                'rw': 'rw',
                'rewardoo': 'rw',
                'reward-oo': 'rw',
                'https://www.rewardoo.com': 'rw',
                'https://www.rewardoo.com/': 'rw',
                # LH (LinkHaitao)
                'lh': 'lh',
                'linkhaitao': 'lh',
                'link-haitao': 'lh',
                'link_haitao': 'lh',
                'https://www.linkhaitao.com': 'lh',
                'https://www.linkhaitao.com/': 'lh',
                # PB (PartnerBoost)
                'pb': 'pb',
                'partnerboost': 'pb',
                'partner-boost': 'pb',
                'https://app.partnerboost.com': 'pb',
                'https://app.partnerboost.com/': 'pb',
                # LB (Linkbux)
                'lb': 'lb',
                'linkbux': 'lb',
                'link-bux': 'lb',
                'https://www.linkbux.com': 'lb',
                'https://www.linkbux.com/': 'lb',
                # PM (Partnermatic)
                'pm': 'pm',
                'partnermatic': 'pm',
                'partner-matic': 'pm',
                'https://app.partnermatic.com': 'pm',
                'https://app.partnermatic.com/': 'pm',
                # BSH (BrandSparkHub)
                'bsh': 'bsh',
                'brandsparkhub': 'bsh',
                'brand-spark-hub': 'bsh',
                'https://www.brandsparkhub.com': 'bsh',
                'https://www.brandsparkhub.com/': 'bsh',
                # CF (CreatorFlare)
                'cf': 'cf',
                'creatorflare': 'cf',
                'creator-flare': 'cf',
                'https://www.creatorflare.com': 'cf',
                'https://www.creatorflare.com/': 'cf',
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
                    # 尝试匹配域名（统一映射到小写缩写）
                    if 'linkhaitao' in domain:
                        platform_final = 'lh'
                    elif 'rewardoo' in domain:
                        platform_final = 'rw'
                    elif 'collabglow' in domain:
                        platform_final = 'cg'
                    elif 'linkbux' in domain:
                        platform_final = 'lb'
                    elif 'partnermatic' in domain:
                        platform_final = 'pm'
                    elif 'partnerboost' in domain:
                        platform_final = 'pb'
                    elif 'brandsparkhub' in domain:
                        platform_final = 'bsh'
                    elif 'creatorflare' in domain:
                        platform_final = 'cf'
            
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
        
        # 基础查询 - 排除已停用账号的交易
        base_query = db.query(AffiliateTransaction).outerjoin(
            AffiliateAccount,
            AffiliateTransaction.affiliate_account_id == AffiliateAccount.id
        ).filter(
            AffiliateTransaction.transaction_time >= begin_datetime,
            AffiliateTransaction.transaction_time <= end_datetime,
            # 排除已停用账号的交易
            (AffiliateAccount.id.is_(None)) | (AffiliateAccount.is_active == True)
        )
        
        # 权限控制
        if current_user.role in ("employee", "member", "leader"):
            base_query = base_query.filter(AffiliateTransaction.user_id == current_user.id)
        
        # 平台筛选
        if platform:
            # 统一转换为小写，数据库中统一存储小写缩写（如 'rw', 'cg', 'lh'）
            platform_lower = platform.lower().strip()
            
            # 平台代码别名映射（前端可能传递缩写、全称或URL，数据库统一存储小写缩写）
            platform_code_map = {
                # CG (CollabGlow)
                'cg': 'cg',
                'collabglow': 'cg',
                'collab-glow': 'cg',
                'https://www.collabglow.com': 'cg',
                'https://www.collabglow.com/': 'cg',
                'https://app.collabglow.com': 'cg',
                'https://app.collabglow.com/': 'cg',
                # RW (Rewardoo)
                'rw': 'rw',
                'rewardoo': 'rw',
                'reward-oo': 'rw',
                'https://www.rewardoo.com': 'rw',
                'https://www.rewardoo.com/': 'rw',
                # LH (LinkHaitao)
                'lh': 'lh',
                'linkhaitao': 'lh',
                'link-haitao': 'lh',
                'link_haitao': 'lh',
                'https://www.linkhaitao.com': 'lh',
                'https://www.linkhaitao.com/': 'lh',
                # PB (PartnerBoost)
                'pb': 'pb',
                'partnerboost': 'pb',
                'partner-boost': 'pb',
                'https://app.partnerboost.com': 'pb',
                'https://app.partnerboost.com/': 'pb',
                # LB (Linkbux)
                'lb': 'lb',
                'linkbux': 'lb',
                'link-bux': 'lb',
                'https://www.linkbux.com': 'lb',
                'https://www.linkbux.com/': 'lb',
                # PM (Partnermatic)
                'pm': 'pm',
                'partnermatic': 'pm',
                'partner-matic': 'pm',
                'https://app.partnermatic.com': 'pm',
                'https://app.partnermatic.com/': 'pm',
                # BSH (BrandSparkHub)
                'bsh': 'bsh',
                'brandsparkhub': 'bsh',
                'brand-spark-hub': 'bsh',
                'https://www.brandsparkhub.com': 'bsh',
                'https://www.brandsparkhub.com/': 'bsh',
                # CF (CreatorFlare)
                'cf': 'cf',
                'creatorflare': 'cf',
                'creator-flare': 'cf',
                'https://www.creatorflare.com': 'cf',
                'https://www.creatorflare.com/': 'cf',
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
                    # 尝试匹配域名（统一映射到小写缩写）
                    if 'linkhaitao' in domain:
                        platform_final = 'lh'
                    elif 'rewardoo' in domain:
                        platform_final = 'rw'
                    elif 'collabglow' in domain:
                        platform_final = 'cg'
                    elif 'linkbux' in domain:
                        platform_final = 'lb'
                    elif 'partnermatic' in domain:
                        platform_final = 'pm'
                    elif 'partnerboost' in domain:
                        platform_final = 'pb'
                    elif 'brandsparkhub' in domain:
                        platform_final = 'bsh'
                    elif 'creatorflare' in domain:
                        platform_final = 'cf'
            
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
        total_approved_commission = float(total_result.approved_commission or 0)  # 已付佣金
        total_rejected_commission = float(total_result.rejected_commission or 0)  # 拒付佣金
        
        # 计算审核佣金（pending状态）
        pending_query = base_query.with_entities(
            func.sum(
                case(
                    (AffiliateTransaction.status == "pending", AffiliateTransaction.commission_amount),
                    else_=0
                )
            ).label('pending_commission')
        )
        pending_result = pending_query.first()
        total_pending_commission = float(pending_result.pending_commission or 0)  # 审核佣金
        
        # 拒付率基于总佣金计算（效仿CollabGlow）
        total_rejected_rate = (total_rejected_commission / total_commission * 100) if total_commission > 0 else 0
        total_net_commission = total_commission - total_rejected_commission  # 净佣金 = 总佣金 - 拒付佣金
        
        # 按平台+账号+MID+商家聚合（汇总模式：参考CG，按MID聚合，区分同平台多账号）
        # 需要统计不同状态的佣金：total（所有状态）、approved（已付）、pending（审核）、rejected（拒付）
        merchant_query = base_query.with_entities(
            AffiliateTransaction.platform,
            AffiliateTransaction.affiliate_account_id,  # 账号ID，用于获取account_index
            AffiliateTransaction.merchant_id,  # 直接使用MID字段
            AffiliateTransaction.merchant,
            func.count(AffiliateTransaction.id).label('orders'),
            func.sum(AffiliateTransaction.order_amount).label('gmv'),
            func.sum(AffiliateTransaction.commission_amount).label('total_commission'),  # 总佣金（所有状态）
            func.sum(
                case(
                    (AffiliateTransaction.status == "approved", AffiliateTransaction.commission_amount),
                    else_=0
                )
            ).label('approved_commission'),  # 已付佣金
            func.sum(
                case(
                    (AffiliateTransaction.status == "pending", AffiliateTransaction.commission_amount),
                    else_=0
                )
            ).label('pending_commission'),  # 审核佣金
            func.sum(
                case(
                    (AffiliateTransaction.status == "rejected", AffiliateTransaction.commission_amount),
                    else_=0
                )
            ).label('rejected_commission')  # 拒付佣金
        ).group_by(
            AffiliateTransaction.platform,
            AffiliateTransaction.affiliate_account_id,  # 按账号分组（区分同平台多账号）
            AffiliateTransaction.merchant_id,  # 按MID分组
            AffiliateTransaction.merchant
        ).order_by(
            AffiliateTransaction.platform,
            func.sum(AffiliateTransaction.commission_amount).desc()
        )
        
        merchant_results = merchant_query.all()
        
        # 获取所有相关账号的 account_index
        account_ids = list(set(r.affiliate_account_id for r in merchant_results if r.affiliate_account_id))
        account_index_map = {}
        if account_ids:
            accounts = db.query(
                AffiliateAccount.id, 
                AffiliateAccount.account_index
            ).filter(AffiliateAccount.id.in_(account_ids)).all()
            account_index_map = {acc.id: acc.account_index for acc in accounts}
        
        merchant_breakdown = []
        for r in merchant_results:
            orders = int(r.orders or 0)
            gmv = float(r.gmv or 0)
            total_comm = float(r.total_commission or 0)  # 总佣金（所有状态）
            approved_comm = float(r.approved_commission or 0)  # 已付佣金
            pending_comm = float(r.pending_commission or 0)  # 审核佣金
            rejected_comm = float(r.rejected_commission or 0)  # 拒付佣金
            
            # MID直接从交易记录获取
            mid = r.merchant_id or ""
            
            # 生成账号标签（如 RW-1, RW-2, 无序号时为 RW）
            platform_code = (r.platform or "").upper()
            account_index = account_index_map.get(r.affiliate_account_id)
            if account_index:
                account_label = f"{platform_code}-{account_index}"
            else:
                account_label = platform_code
            
            merchant_breakdown.append({
                "mid": mid,
                "merchant": r.merchant or "",
                "platform": r.platform,
                "account_label": account_label,
                "orders": orders,
                "gmv": round(gmv, 2),
                "total_commission": round(total_comm, 2),  # 总佣金（所有状态，对应Est. Commission）
                "approved_commission": round(approved_comm, 2),  # 已付佣金
                "pending_commission": round(pending_comm, 2),  # 审核佣金
                "rejected_commission": round(rejected_comm, 2)  # 拒付佣金
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
        
        # 按账号聚合（用于筛选器，区分同平台多账号）
        account_query = base_query.with_entities(
            AffiliateTransaction.platform,
            AffiliateTransaction.affiliate_account_id,
            func.count(AffiliateTransaction.id).label('orders'),
            func.sum(AffiliateTransaction.commission_amount).label('total_commission')
        ).filter(
            AffiliateTransaction.affiliate_account_id.isnot(None)
        ).group_by(
            AffiliateTransaction.platform,
            AffiliateTransaction.affiliate_account_id
        ).order_by(
            AffiliateTransaction.platform,
            func.sum(AffiliateTransaction.commission_amount).desc()
        )
        
        account_results = account_query.all()
        
        # 获取账号信息
        account_ids_for_breakdown = list(set(r.affiliate_account_id for r in account_results if r.affiliate_account_id))
        account_info_map = {}
        if account_ids_for_breakdown:
            accounts_info = db.query(
                AffiliateAccount.id,
                AffiliateAccount.account_index
            ).filter(AffiliateAccount.id.in_(account_ids_for_breakdown)).all()
            account_info_map = {acc.id: acc.account_index for acc in accounts_info}
        
        account_breakdown = []
        for r in account_results:
            platform_code = (r.platform or "").upper()
            account_index = account_info_map.get(r.affiliate_account_id)
            if account_index:
                account_label = f"{platform_code}-{account_index}"
            else:
                account_label = platform_code
            
            account_breakdown.append({
                "account_label": account_label,
                "platform": r.platform,
                "account_id": r.affiliate_account_id,
                "orders": int(r.orders or 0),
                "total_commission": round(float(r.total_commission or 0), 2)
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
            "total_commission": round(total_commission, 2),  # 总佣金（所有状态，对应Est. Commission）
            "total_approved_commission": round(total_approved_commission, 2),  # 已付佣金
            "total_pending_commission": round(total_pending_commission, 2),  # 审核佣金
            "total_rejected_commission": round(total_rejected_commission, 2),  # 拒付佣金
            "total_rejected_rate": round(total_rejected_rate, 2),
            "total_net_commission": round(total_net_commission, 2),
            "merchant_breakdown": merchant_breakdown,  # 按商家聚合（MID、商家、订单数、销售额、佣金）
            "platform_breakdown": platform_breakdown,  # 按平台聚合（保留用于兼容）
            "account_breakdown": account_breakdown  # 按账号聚合（用于筛选器）
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


@router.get("/transactions")
async def get_platform_transactions(
    begin_date: str = Query(..., description="开始日期 YYYY-MM-DD"),
    end_date: str = Query(..., description="结束日期 YYYY-MM-DD"),
    platform: Optional[str] = Query(None, description="平台代码（可选）"),
    status: Optional[str] = Query(None, description="状态筛选: pending/approved/rejected"),
    merchant: Optional[str] = Query(None, description="商户名称（可选，支持模糊匹配）"),
    page: int = Query(1, ge=1, description="页码"),
    page_size: int = Query(50, ge=1, le=200, description="每页数量"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    获取原始交易记录（每条交易一行）
    
    返回分页的交易记录列表
    """
    try:
        # 解析日期
        begin = datetime.strptime(begin_date, "%Y-%m-%d").date()
        end = datetime.strptime(end_date, "%Y-%m-%d").date()
        begin_datetime = datetime.combine(begin, datetime.min.time())
        end_datetime = datetime.combine(end, datetime.max.time())
        
        # 基础查询
        query = db.query(AffiliateTransaction).outerjoin(
            AffiliateAccount,
            AffiliateTransaction.affiliate_account_id == AffiliateAccount.id
        ).filter(
            AffiliateTransaction.transaction_time >= begin_datetime,
            AffiliateTransaction.transaction_time <= end_datetime,
            (AffiliateAccount.id.is_(None)) | (AffiliateAccount.is_active == True)
        )
        
        # 权限控制
        if current_user.role in ("employee", "member", "leader"):
            query = query.filter(AffiliateTransaction.user_id == current_user.id)
        
        # 平台筛选（数据库统一存储小写缩写）
        if platform:
            platform_lower = platform.lower().strip()
            platform_code_map = {
                'cg': 'cg', 'collabglow': 'cg',
                'rw': 'rw', 'rewardoo': 'rw',
                'lh': 'lh', 'linkhaitao': 'lh',
                'pb': 'pb', 'partnerboost': 'pb',
                'lb': 'lb', 'linkbux': 'lb',
                'pm': 'pm', 'partnermatic': 'pm',
                'bsh': 'bsh', 'brandsparkhub': 'bsh',
                'cf': 'cf', 'creatorflare': 'cf',
            }
            platform_final = platform_code_map.get(platform_lower, platform_lower)
            query = query.filter(AffiliateTransaction.platform == platform_final)
        
        # 状态筛选
        if status and status.lower() != 'all':
            query = query.filter(AffiliateTransaction.status == status.lower())
        
        # 商户筛选
        if merchant:
            query = query.filter(AffiliateTransaction.merchant.ilike(f"%{merchant}%"))
        
        # 获取总数
        total = query.count()
        
        # 分页和排序
        query = query.order_by(AffiliateTransaction.transaction_time.desc())
        offset = (page - 1) * page_size
        transactions = query.offset(offset).limit(page_size).all()
        
        # 转换为响应格式
        result = []
        for txn in transactions:
            result.append({
                "id": txn.id,
                "transaction_time": txn.transaction_time.isoformat() if txn.transaction_time else None,
                "platform": txn.platform,
                "merchant_id": txn.merchant_id,
                "merchant": txn.merchant,
                "transaction_id": txn.transaction_id,  # 交易ID
                "order_amount": round(float(txn.order_amount or 0), 2),
                "commission_amount": round(float(txn.commission_amount or 0), 2),
                "status": txn.status,
                "currency": txn.currency or "USD",
            })
        
        return {
            "total": total,
            "page": page,
            "page_size": page_size,
            "pages": (total + page_size - 1) // page_size,
            "transactions": result
        }
        
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"日期格式错误: {str(e)}")
    except Exception as e:
        logger.error(f"获取交易记录失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"查询失败: {str(e)}")


def _do_platform_sync_background(user_id: int, account_ids: list, start_date: str, end_date: str):
    """后台执行平台数据同步（在独立线程中运行）"""
    from app.database import SessionLocal
    from app.services.platform_data_sync import PlatformDataSyncService
    
    db = SessionLocal()
    try:
        sync_service = PlatformDataSyncService(db)
        synced = 0
        for account_id in account_ids:
            try:
                result = sync_service.sync_account_data(
                    account_id=account_id,
                    begin_date=start_date,
                    end_date=end_date
                )
                if result.get("success"):
                    synced += 1
                    logger.info(f"[后台同步] 账号 {account_id} 同步成功: {result.get('saved_count', 0)} 条记录")
                else:
                    logger.warning(f"[后台同步] 账号 {account_id} 同步失败: {result.get('message')}")
            except Exception as e:
                logger.error(f"[后台同步] 账号 {account_id} 同步异常: {e}")
        
        logger.info(f"[后台同步] 用户 {user_id} 完成同步: {synced}/{len(account_ids)} 个账号")
    except Exception as e:
        logger.error(f"[后台同步] 用户 {user_id} 同步失败: {e}", exc_info=True)
    finally:
        db.close()


@router.post("/sync-realtime")
async def sync_platform_data_realtime(
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    实时同步平台数据（最近3天）- 后台任务模式
    立即返回，同步在后台执行
    """
    from datetime import timedelta
    
    try:
        # 计算最近3天的日期范围
        end_date = date.today()
        start_date = end_date - timedelta(days=2)  # 今天 + 前2天 = 3天
        
        logger.info(f"用户 {current_user.username} 触发实时同步（后台模式），日期范围: {start_date} ~ {end_date}")
        
        # 获取用户的所有平台账号
        accounts = db.query(AffiliateAccount).filter(
            AffiliateAccount.user_id == current_user.id,
            AffiliateAccount.is_active == True
        ).all()
        
        if not accounts:
            return {
                "success": True,
                "message": "没有找到活跃的平台账号",
                "synced_accounts": 0,
                "total_accounts": 0,
                "total_records": 0
            }
        
        account_ids = [acc.id for acc in accounts]
        
        # 使用线程池在后台执行同步（避免阻塞）
        import threading
        sync_thread = threading.Thread(
            target=_do_platform_sync_background,
            args=(current_user.id, account_ids, start_date.strftime("%Y-%m-%d"), end_date.strftime("%Y-%m-%d"))
        )
        sync_thread.daemon = True
        sync_thread.start()
        
        return {
            "success": True,
            "message": f"同步已在后台开始，正在同步 {len(accounts)} 个账号，请稍后刷新页面查看结果",
            "synced_accounts": 0,  # 后台执行，暂时返回0
            "total_accounts": len(accounts),
            "total_records": 0,
            "date_range": f"{start_date} ~ {end_date}",
            "background": True  # 标记为后台任务
        }
        
    except Exception as e:
        logger.error(f"启动后台同步失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"启动同步失败: {str(e)}")

