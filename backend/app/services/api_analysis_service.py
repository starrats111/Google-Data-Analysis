"""
基于API数据的分析服务
支持日期范围，生成每日分析记录
"""
from datetime import date, timedelta
from typing import Dict, Optional, List
from sqlalchemy.orm import Session
from sqlalchemy import func
import logging

from app.models.google_ads_api_data import GoogleAdsApiData
from app.models.platform_data import PlatformData
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.analysis_result import AnalysisResult

logger = logging.getLogger(__name__)


class ApiAnalysisService:
    """基于API数据的分析服务"""
    
    def __init__(self, db: Session):
        self.db = db
    
    def generate_daily_analysis(
        self,
        begin_date: date,
        end_date: date,
        user_id: Optional[int] = None
    ) -> Dict:
        """
        生成日期范围内每一天的分析
        
        Args:
            begin_date: 开始日期
            end_date: 结束日期
            user_id: 用户ID
        """
        logger.info(f"=== 开始生成每日分析 === 范围: {begin_date} ~ {end_date}, 用户ID: {user_id}")
        
        total_created = 0
        total_skipped = 0
        errors = []
        
        # 遍历日期范围内的每一天
        current_date = begin_date
        while current_date <= end_date:
            try:
                result = self._generate_single_day_analysis(current_date, user_id)
                total_created += result.get("created", 0)
                total_skipped += result.get("skipped", 0)
                if result.get("error"):
                    errors.append(f"{current_date}: {result['error']}")
            except Exception as e:
                logger.error(f"处理 {current_date} 失败: {e}")
                errors.append(f"{current_date}: {str(e)}")
            
            current_date += timedelta(days=1)
        
        # 提交所有更改
        try:
            self.db.commit()
        except Exception as e:
            logger.error(f"提交数据库失败: {e}")
            self.db.rollback()
            return {"success": False, "message": f"保存失败: {str(e)}"}
        
        logger.info(f"=== 每日分析完成 === 创建: {total_created}, 跳过: {total_skipped}")
        
        return {
            "success": True,
            "begin_date": begin_date.isoformat(),
            "end_date": end_date.isoformat(),
            "total_records": total_created,
            "skipped_records": total_skipped,
            "errors": errors if errors else None
        }
    
    def _generate_single_day_analysis(
        self,
        target_date: date,
        user_id: Optional[int] = None
    ) -> Dict:
        """生成单天的分析 - 按广告系列展示"""
        
        # 1. 查询Google Ads数据
        query = self.db.query(GoogleAdsApiData).filter(
                GoogleAdsApiData.date == target_date
            )
        if user_id:
            query = query.filter(GoogleAdsApiData.user_id == user_id)
        
        google_ads_data = query.all()
        
        if not google_ads_data:
            return {"created": 0, "skipped": 0}
        
        # 2. 计算本周数据（用于本周出单天数、本周总订单数、本周ROI）
        # 本周定义：target_date所在周的周一到target_date
        days_since_monday = target_date.weekday()  # 0=Monday
        week_start = target_date - timedelta(days=days_since_monday)
        
        # 3. 按用户分组处理
        user_campaigns = {}
            for data in google_ads_data:
            data_user_id = data.user_id
            if data_user_id not in user_campaigns:
                user_campaigns[data_user_id] = []
            user_campaigns[data_user_id].append(data)
        
        created = 0
        skipped = 0
        
        for data_user_id, campaigns in user_campaigns.items():
            # 查找用户的联盟账号（按平台分组）
            platform_accounts = {}
            for campaign in campaigns:
                platform_code = campaign.extracted_platform_code
                if not platform_code:
                    continue
                if platform_code not in platform_accounts:
                    acc = self.db.query(AffiliateAccount).join(
                        AffiliatePlatform
                    ).filter(
                        AffiliateAccount.user_id == data_user_id,
                        AffiliatePlatform.platform_name == platform_code,
                        AffiliateAccount.is_active == True
                    ).first()
                    platform_accounts[platform_code] = acc
            
            # 找到任意一个联盟账号用于存储结果
            affiliate_account = None
            for acc in platform_accounts.values():
                if acc:
                    affiliate_account = acc
                    break
                
                if not affiliate_account:
                skipped += 1
                    continue
                
            # 检查是否已存在
            existing = self.db.query(AnalysisResult).filter(
                AnalysisResult.user_id == data_user_id,
                AnalysisResult.affiliate_account_id == affiliate_account.id,
                AnalysisResult.analysis_date == target_date,
                AnalysisResult.analysis_type == "daily"
            ).first()
            
            if existing:
                skipped += 1
                continue
            
            # 查询本周的Google Ads数据
            week_query = self.db.query(GoogleAdsApiData).filter(
                GoogleAdsApiData.user_id == data_user_id,
                GoogleAdsApiData.date >= week_start,
                GoogleAdsApiData.date <= target_date
            )
            week_data = week_query.all()
            
            # 按广告系列聚合本周数据
            week_campaign_data = {}
            for d in week_data:
                cname = d.campaign_name
                if cname not in week_campaign_data:
                    week_campaign_data[cname] = {
                        "cost": 0.0,
                        "clicks": 0,
                        "order_days": set(),
                        "orders": 0,
                        "commission": 0.0,
                    }
                week_campaign_data[cname]["cost"] += (d.cost or 0)
                week_campaign_data[cname]["clicks"] += int(d.clicks or 0)
            
            # 获取本周平台数据（订单和佣金）
            platform_daily_data = {}  # {platform_code: {date: {orders, commission}}}
            platform_week_totals = {}  # {platform_code: {orders, commission, order_days}}
            
            for platform_code, acc in platform_accounts.items():
                if not acc:
                    continue
                platform_daily_data[platform_code] = {}
                platform_week_totals[platform_code] = {"orders": 0, "commission": 0.0, "order_days": 0}
                
                week_platform_data = self.db.query(PlatformData).filter(
                    PlatformData.affiliate_account_id == acc.id,
                    PlatformData.date >= week_start,
                    PlatformData.date <= target_date
                ).all()
                
                for pd in week_platform_data:
                    platform_daily_data[platform_code][pd.date] = {
                        "orders": pd.orders or 0,
                        "commission": pd.commission or 0.0
                    }
                    platform_week_totals[platform_code]["orders"] += (pd.orders or 0)
                    platform_week_totals[platform_code]["commission"] += (pd.commission or 0.0)
                    if pd.orders and pd.orders > 0:
                        platform_week_totals[platform_code]["order_days"] += 1
            
            # 4. 生成每个广告系列的数据行
            rows = []
            for campaign in campaigns:
                cname = campaign.campaign_name
                week_info = week_campaign_data.get(cname, {})
                
                # 当天数据
                cost = campaign.cost or 0
                clicks = int(campaign.clicks or 0)
                budget = campaign.budget or 0
                cpc = campaign.cpc or 0
                is_budget_lost = campaign.is_budget_lost or 0
                is_rank_lost = campaign.is_rank_lost or 0
                status = campaign.status or "ENABLED"
                platform_code = campaign.extracted_platform_code
                
                # 从PlatformData获取当天的订单和佣金
                orders = 0
                commission = 0.0
                if platform_code and platform_code in platform_daily_data:
                    daily_pd = platform_daily_data[platform_code].get(target_date, {})
                    orders = daily_pd.get("orders", 0)
                    commission = daily_pd.get("commission", 0.0)
                
                # 本周数据
                week_cost = week_info.get("cost", cost)
                week_clicks = week_info.get("clicks", clicks)
                
                # 从平台周数据获取订单和佣金
                week_orders = 0
                week_order_days = 0
                week_commission = 0.0
                if platform_code and platform_code in platform_week_totals:
                    week_totals = platform_week_totals[platform_code]
                    week_orders = week_totals.get("orders", 0)
                    week_order_days = week_totals.get("order_days", 0)
                    week_commission = week_totals.get("commission", 0.0)
                
                # ROI计算
                conservative_commission = commission * 0.72
                roi = ((conservative_commission - cost) / cost * 100) if cost > 0 else 0
                
                # 本周ROI
                week_conservative_commission = week_commission * 0.72
                week_roi = ((week_conservative_commission - week_cost) / week_cost * 100) if week_cost > 0 else 0
                
                # 操作指令
                operation = self._generate_operation_instruction(
                    is_budget_lost, is_rank_lost, roi, orders
                )
                
                # 根据表现判断状态：健康/观察/暂停
                health_status = self._calculate_health_status(
                    status, roi, is_budget_lost, is_rank_lost, orders, clicks
                )
                
                rows.append({
                    "广告系列名": cname,
                    "状态": health_status,
                    "预算": round(budget, 2),
                    "点击": clicks,
                    "订单": orders,
                    "佣金": round(commission, 2),
                    "费用": round(cost, 2),
                    "本周出单天数": week_order_days,
                    "本周总订单数": week_orders,
                    "CPC": round(cpc, 4),
                    "IS Budget丢失": f"{is_budget_lost * 100:.1f}%" if is_budget_lost > 0 else "-",
                    "IS Rank丢失": f"{is_rank_lost * 100:.1f}%" if is_rank_lost > 0 else "-",
                    "ROI": f"{roi:.1f}%" if cost > 0 else "-",
                    "本周ROI": f"{week_roi:.1f}%" if week_cost > 0 else "-",
                    "操作指令": operation,
                })
            
            # 构建完整数据
            result_data = {"data": rows}
            
            analysis_result = AnalysisResult(
                user_id=data_user_id,
                affiliate_account_id=affiliate_account.id,
                analysis_date=target_date,
                analysis_type="daily",
                result_data=result_data
            )
            self.db.add(analysis_result)
            created += 1
        
        return {"created": created, "skipped": skipped}
    
    def _calculate_health_status(
        self,
        google_status: str,
        roi: float,
        is_budget_lost: float,
        is_rank_lost: float,
        orders: int,
        clicks: int
    ) -> str:
        """
        根据广告表现计算健康状态
        
        Returns:
            健康 / 观察 / 暂停
        """
        # 如果Google Ads状态是暂停或删除
        if google_status in ["PAUSED", "REMOVED"]:
            return "暂停"
        
        # ROI为负或很低
        if roi < -50:
            return "暂停"
        
        # 有问题需要观察
        issues = 0
        if roi < 0:
            issues += 1
        if is_budget_lost > 0.2:  # 预算丢失超过20%
            issues += 1
        if is_rank_lost > 0.3:  # 排名丢失超过30%
            issues += 1
        if clicks > 50 and orders == 0:  # 点击多但无订单
            issues += 1
        
        if issues >= 2:
            return "观察"
        elif issues == 1:
            return "观察"
        
        return "健康"
    
    def _generate_operation_instruction(
        self,
        is_budget_lost: float,
        is_rank_lost: float,
        roi: float,
        orders: int
    ) -> str:
        """生成操作指令"""
        instructions = []
        
        if is_budget_lost > 0.1:
            instructions.append(f"预算丢失{is_budget_lost*100:.0f}%，增加预算")
        
        if is_rank_lost > 0.1:
            instructions.append(f"排名丢失{is_rank_lost*100:.0f}%，提高出价")
        
        if roi < 0:
            instructions.append("ROI为负，建议暂停")
        elif roi < 20:
            instructions.append("ROI较低，优化广告")
        
        if orders == 0:
            instructions.append("无订单，检查转化")
        
        return "；".join(instructions) if instructions else "正常运行"
    
    def generate_l7d_analysis(
        self,
        end_date: date,
        user_id: Optional[int] = None
    ) -> Dict:
        """生成L7D分析 - 按广告系列展示"""
        begin_date = end_date - timedelta(days=6)
        logger.info(f"=== 开始生成L7D分析 === 范围: {begin_date} ~ {end_date}")
        
        try:
            query = self.db.query(GoogleAdsApiData).filter(
                GoogleAdsApiData.date >= begin_date,
                GoogleAdsApiData.date <= end_date
            )
            if user_id:
                query = query.filter(GoogleAdsApiData.user_id == user_id)
            
            google_ads_data = query.all()
            
            if not google_ads_data:
                return {"success": True, "total_records": 0, "message": "没有数据"}
            
            # 按广告系列分组（而不是按平台）
            campaign_data = {}
            for data in google_ads_data:
                key = (data.campaign_id, data.user_id)
                if key not in campaign_data:
                    # 从广告系列名解析MID、投放国家
                    _, mid, country = self._parse_campaign_name(data.campaign_name)
                    # CID直接从Google Ads数据获取（customer_id字段）
                    cid = data.customer_id or ""
                    # 格式化CID为 xxx-xxx-xxxx 格式
                    if cid and len(cid) == 10:
                        cid = f"{cid[:3]}-{cid[3:6]}-{cid[6:]}"
                    campaign_data[key] = {
                        "campaign_id": data.campaign_id,
                        "campaign_name": data.campaign_name,
                        "user_id": data.user_id,
                        "platform_code": data.extracted_platform_code,
                        "cid": cid,
                        "mid": mid,
                        "country": country,
                        "data_dates": set(),  # 有数据的天数
                        "total_cost": 0.0,
                        "total_clicks": 0,
                        "max_cpc": 0.0,
                        "is_budget_lost": 0.0,
                        "is_rank_lost": 0.0,
                    }
                # 记录有数据的日期
                campaign_data[key]["data_dates"].add(data.date)
                campaign_data[key]["total_cost"] += (data.cost or 0)
                campaign_data[key]["total_clicks"] += int(data.clicks or 0)
                campaign_data[key]["max_cpc"] = max(campaign_data[key]["max_cpc"], (data.cpc or 0))
                campaign_data[key]["is_budget_lost"] = max(campaign_data[key]["is_budget_lost"], (data.is_budget_lost or 0))
                campaign_data[key]["is_rank_lost"] = max(campaign_data[key]["is_rank_lost"], (data.is_rank_lost or 0))
            
            # 按用户分组生成结果
            user_results = {}
            for key, cdata in campaign_data.items():
                data_user_id = cdata["user_id"]
                platform_code = cdata.get("platform_code")
                mid = cdata.get("mid")  # 商家ID
                
                # 从AffiliateTransaction获取佣金和订单数
                commission = 0.0
                orders = 0
                order_days = 0  # 有订单的天数
                
                # 从广告系列名提取MID和商家名（格式: 序号-平台-商家名-国家-日期-MID）
                campaign_name = cdata.get("campaign_name", "")
                merchant_name = self._extract_merchant_from_campaign(campaign_name)
                
                from app.models.affiliate_transaction import AffiliateTransaction
                from sqlalchemy import func
                
                # 平台代码映射
                platform_map = {
                    "LH": "linkhaitao", "LH1": "linkhaitao",
                    "PM": "pepperjam", "PM1": "pepperjam",
                    "CG": "cg", "CG1": "cg",
                    "RW": "rw", "RW1": "rw",
                }
                txn_platform = platform_map.get(platform_code, platform_code.lower() if platform_code else "")
                
                # 策略1：优先用MID精准匹配
                matched = False
                if mid:
                    txn_query = self.db.query(
                        func.sum(AffiliateTransaction.commission_amount).label('total_commission'),
                        func.count(AffiliateTransaction.id).label('total_orders'),
                        func.count(func.distinct(func.date(AffiliateTransaction.transaction_time))).label('order_days')
                    ).filter(
                        AffiliateTransaction.user_id == data_user_id,
                        func.date(AffiliateTransaction.transaction_time) >= begin_date,
                        func.date(AffiliateTransaction.transaction_time) <= end_date,
                        AffiliateTransaction.merchant_id == str(mid)
                    )
                    if txn_platform:
                        txn_query = txn_query.filter(AffiliateTransaction.platform == txn_platform)
                    
                    result = txn_query.first()
                    if result and result.total_orders:
                        commission = float(result.total_commission or 0)
                        orders = int(result.total_orders or 0)
                        order_days = int(result.order_days or 0)
                        matched = True
                        logger.info(f"L7D MID精准匹配成功: MID={mid}, 平台={txn_platform}, 佣金={commission}, 订单={orders}")
                
                # 策略2：MID没匹配到，用商家名模糊匹配
                if not matched and merchant_name:
                    txn_query = self.db.query(
                        func.sum(AffiliateTransaction.commission_amount).label('total_commission'),
                        func.count(AffiliateTransaction.id).label('total_orders'),
                        func.count(func.distinct(func.date(AffiliateTransaction.transaction_time))).label('order_days')
                    ).filter(
                        AffiliateTransaction.user_id == data_user_id,
                        func.date(AffiliateTransaction.transaction_time) >= begin_date,
                        func.date(AffiliateTransaction.transaction_time) <= end_date,
                        # 商家名模糊匹配（忽略大小写和空格）
                        func.lower(func.replace(AffiliateTransaction.merchant, ' ', '')).like(f"%{merchant_name.lower()}%")
                    )
                    if txn_platform:
                        txn_query = txn_query.filter(AffiliateTransaction.platform == txn_platform)
                    
                    result = txn_query.first()
                    if result and result.total_orders:
                        commission = float(result.total_commission or 0)
                        orders = int(result.total_orders or 0)
                        order_days = int(result.order_days or 0)
                        logger.info(f"L7D 商家名匹配成功: merchant={merchant_name}, 平台={txn_platform}, 佣金={commission}, 订单={orders}")
                
                # 计算保守EPC和保守ROI
                cost = cdata["total_cost"]
                clicks = cdata["total_clicks"]
                data_days = len(cdata["data_dates"])  # 有Google Ads数据的天数
                
                conservative_epc = (commission * 0.72 / clicks) if clicks > 0 else 0
                conservative_roi = ((commission * 0.72 - cost) / cost) if cost > 0 else None
                
                # 生成操作指令
                operation = self._generate_l7d_operation(
                    conservative_roi, cdata["is_budget_lost"], cdata["is_rank_lost"], 
                    order_days, cdata["max_cpc"], orders
                )
                
                row = {
                    "账号=CID": cdata["cid"],
                    "广告系列名": cdata["campaign_name"],
                    "MID": cdata["mid"],
                    "投放国家": cdata["country"],
                    "L7D点击": clicks,
                    "L7D佣金": round(commission, 2),
                    "L7D花费": round(cost, 2),
                    "L7D出单天数": order_days,
                    "当前Max CPC": round(cdata["max_cpc"], 4),
                    "IS Budget丢失": f"{cdata['is_budget_lost'] * 100:.1f}%" if cdata['is_budget_lost'] > 0 else "-",
                    "IS Rank丢失": f"{cdata['is_rank_lost'] * 100:.1f}%" if cdata['is_rank_lost'] > 0 else "-",
                    "保守EPC": round(conservative_epc, 4),
                    "保守ROI": f"{conservative_roi * 100:.1f}%" if conservative_roi is not None else "-",
                    "操作指令": operation,
                }
                
                if data_user_id not in user_results:
                    user_results[data_user_id] = []
                user_results[data_user_id].append(row)
            
            # 保存到数据库
            total_saved = 0
            for data_user_id, rows in user_results.items():
                # 找一个联盟账号用于关联
                affiliate_account = self.db.query(AffiliateAccount).filter(
                    AffiliateAccount.user_id == data_user_id,
                    AffiliateAccount.is_active == True
                ).first()
                
                if not affiliate_account:
                    continue
                
                # 检查是否已存在
                existing = self.db.query(AnalysisResult).filter(
                    AnalysisResult.user_id == data_user_id,
                    AnalysisResult.analysis_date == end_date,
                    AnalysisResult.analysis_type == "l7d"
                ).first()
                
                if existing:
                    # 更新现有记录
                    existing.result_data = {"data": rows}
                else:
                    # 创建新记录
                    analysis_result = AnalysisResult(
                        user_id=data_user_id,
                        affiliate_account_id=affiliate_account.id,
                        analysis_date=end_date,
                        analysis_type="l7d",
                        result_data={"data": rows}
                    )
                    self.db.add(analysis_result)
                total_saved += len(rows)
            
            # 提交数据库
            try:
                self.db.commit()
            except Exception as e:
                logger.error(f"保存L7D分析失败: {e}")
                self.db.rollback()
            
            return {
                "success": True,
                "begin_date": begin_date.isoformat(),
                "end_date": end_date.isoformat(),
                "total_records": total_saved
            }
            
        except Exception as e:
            logger.error(f"L7D分析失败: {e}", exc_info=True)
            return {"success": False, "message": str(e)}
    
    def _parse_campaign_name(self, campaign_name: str) -> tuple:
        """从广告系列名解析CID、MID、投放国家"""
        import re
        # 示例格式: 001-RW-bofrost-US-0126-126966
        # 或: 002-RW-revisionskincare-US-0126-116022
        # 格式: 序号-平台-商家名-国家-日期-MID
        parts = campaign_name.split("-") if campaign_name else []
        
        cid = ""
        mid = ""
        country = ""
        
        if len(parts) >= 4:
            # 国家代码通常在平台代码之后（跳过前两个：序号和平台）
            # 遍历找到2个大写字母的国家代码，但排除平台代码(RW, CG等)
            platform_codes = {"RW", "CG", "PM", "LH", "LS", "RW1", "CG1", "PM1", "LH1"}  # 已知平台代码
            for p in parts[2:]:  # 从第3个元素开始找
                if re.match(r'^[A-Z]{2}$', p) and p not in platform_codes:
                    country = p
                    break
            
            # 尝试提取MID（最后的纯数字部分，通常6位）
            for p in reversed(parts):
                if p.isdigit() and len(p) >= 5:
                    mid = p
                    break
        
        return cid, mid, country
    
    def _extract_merchant_from_campaign(self, campaign_name: str) -> str:
        """
        从广告系列名提取商家名
        格式: 序号-平台-商家名-国家-日期-MID
        示例: 117-LH1-hotelcollection-US-1226-154253 -> hotelcollection
        """
        if not campaign_name:
            return ""
        
        parts = campaign_name.split("-")
        if len(parts) >= 3:
            # 第3个部分是商家名（索引2）
            merchant = parts[2]
            return merchant
        
        return ""
    
    def _generate_l7d_operation(
        self,
        conservative_roi: Optional[float],
        is_budget_lost: float,
        is_rank_lost: float,
        order_days: int,
        max_cpc: float,
        orders: int
    ) -> str:
        """生成L7D操作指令"""
        instructions = []
        
        # ROI判断
        if conservative_roi is not None:
            if conservative_roi < -0.5:
                return "关停"
            elif conservative_roi < 0:
                instructions.append("ROI为负")
        
        # 预算丢失
        if is_budget_lost > 0.2:
            instructions.append("加预算")
        
        # 排名丢失
        if is_rank_lost > 0.3:
            instructions.append("提高CPC")
        
        # 出单情况
        if order_days == 0 and orders == 0:
            if instructions:
                instructions.append("观察")
            else:
                return "样本不足"
        
        return "；".join(instructions) if instructions else "稳定运行"
