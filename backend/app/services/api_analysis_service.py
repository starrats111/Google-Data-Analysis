"""
基于API数据的分析服务
支持日期范围，生成每日分析记录
"""
from datetime import date, timedelta
from typing import Dict, Optional, List
from sqlalchemy.orm import Session
from sqlalchemy import func
import logging
import re

from app.models.google_ads_api_data import GoogleAdsApiData
from app.models.platform_data import PlatformData
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.analysis_result import AnalysisResult
from app.models.ai_report import UserPrompt

logger = logging.getLogger(__name__)


class ApiAnalysisService:
    """基于API数据的分析服务"""
    
    # 平台代码标准化映射（PM1 → PM，CG1 → CG 等）
    PLATFORM_CODE_MAP = {
        "PM": "PM", "PM1": "PM", "PM2": "PM", "PM3": "PM",
        "CG": "CG", "CG1": "CG", "CG2": "CG", "CG3": "CG",
        "RW": "RW", "RW1": "RW", "RW2": "RW", "RW3": "RW",
        "LH": "LH", "LH1": "LH", "LH2": "LH", "LH3": "LH",
        "LS": "LS", "LS1": "LS", "LS2": "LS", "LS3": "LS",
    }
    
    @classmethod
    def normalize_platform_code(cls, code: str) -> str:
        """
        标准化平台代码
        PM1 → PM, CG1 → CG, RW1 → RW 等
        """
        if not code:
            return code
        code_upper = code.upper().strip()
        # 先检查映射表
        if code_upper in cls.PLATFORM_CODE_MAP:
            return cls.PLATFORM_CODE_MAP[code_upper]
        # 如果不在映射表，尝试去除尾部数字
        import re
        match = re.match(r'^([A-Z]+)\d*$', code_upper)
        if match:
            return match.group(1)
        return code_upper
    
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
        
        # 预加载MCC货币配置（用于人民币转美金）
        from app.models.google_ads_api_data import GoogleMccAccount
        from app.config import settings
        
        CNY_TO_USD_RATE = float(getattr(settings, "CNY_TO_USD_RATE", 7.2) or 7.2)
        
        # 获取所有MCC的货币配置
        mcc_currency_map = {}  # {mcc_id: currency}
        all_mccs = self.db.query(GoogleMccAccount).all()
        for mcc in all_mccs:
            mcc_currency_map[mcc.id] = getattr(mcc, 'currency', 'USD') or 'USD'
        
        def convert_to_usd(amount: float, currency: str) -> float:
            """将金额转换为美元"""
            if currency and currency.upper() == "CNY":
                return amount / CNY_TO_USD_RATE
            return amount
        
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
            
            # 按广告系列聚合本周数据（包含货币转换）
            week_campaign_data = {}
            for d in week_data:
                cname = d.campaign_name
                mcc_currency = mcc_currency_map.get(d.mcc_id, "USD")
                if cname not in week_campaign_data:
                    week_campaign_data[cname] = {
                        "cost": 0.0,
                        "clicks": 0,
                        "order_days": set(),
                        "orders": 0,
                        "commission": 0.0,
                    }
                # 费用需要进行货币转换
                week_campaign_data[cname]["cost"] += convert_to_usd(d.cost or 0, mcc_currency)
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
                
                # 获取当前广告系列的MCC货币类型
                campaign_currency = mcc_currency_map.get(campaign.mcc_id, "USD")
                
                # 当天数据（费用、CPC、预算需要货币转换）
                cost = convert_to_usd(campaign.cost or 0, campaign_currency)
                clicks = int(campaign.clicks or 0)
                budget = convert_to_usd(campaign.budget or 0, campaign_currency)
                cpc = convert_to_usd(campaign.cpc or 0, campaign_currency)
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
                
                # 操作指令（带具体数值）
                operation = self._generate_operation_instruction(
                    is_budget_lost, is_rank_lost, roi, orders, cpc, budget
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
        orders: int,
        cpc: float = 0,
        budget: float = 0
    ) -> str:
        """
        生成操作指令（简洁格式）
        格式: CPC $X.XX→$X.XX | 预算 $X.XX→$X.XX(+X%)
        """
        
        # ROI 严重为负，关停
        if roi < -40:
            return "关停"
        
        instructions = []
        
        # ROI 为负，降价
        if roi < 0:
            if cpc > 0:
                new_cpc = max(0.01, cpc - 0.05)
                instructions.append(f"CPC ${cpc:.2f}→${new_cpc:.2f}")
            else:
                instructions.append("关停")
        
        # ROI 优秀且有预算瓶颈，加预算
        elif roi > 150 and is_budget_lost > 0.2:
            if budget > 0 and cpc > 0:
                new_budget = budget * 1.3
                pct = 30
                instructions.append(f"CPC ${cpc:.2f}→${cpc:.2f} | 预算 ${budget:.2f}→${new_budget:.2f}(+{pct}%)")
            elif budget > 0:
                new_budget = budget * 1.3
                instructions.append(f"预算 ${budget:.2f}→${new_budget:.2f}(+30%)")
            else:
                instructions.append("加预算")
            # 同时可能需要提高CPC
            if is_rank_lost > 0.15 and cpc > 0 and len(instructions) > 0 and "CPC" not in instructions[0]:
                new_cpc = cpc + 0.02
                instructions.insert(0, f"CPC ${cpc:.2f}→${new_cpc:.2f}")
        
        # ROI 良好且有排名瓶颈，提高CPC
        elif roi > 100 and is_rank_lost > 0.15:
            if cpc > 0:
                new_cpc = cpc + 0.02
                if budget > 0:
                    instructions.append(f"CPC ${cpc:.2f}→${new_cpc:.2f} | 预算 ${budget:.2f}→${budget:.2f}(+0%)")
                else:
                    instructions.append(f"CPC ${cpc:.2f}→${new_cpc:.2f}")
            else:
                instructions.append("提高CPC")
        
        # ROI 中等，有预算瓶颈
        elif roi >= 80 and is_budget_lost > 0.3:
            if budget > 0:
                new_budget = budget * 1.2
                pct = 20
                if cpc > 0:
                    instructions.append(f"CPC ${cpc:.2f}→${cpc:.2f} | 预算 ${budget:.2f}→${new_budget:.2f}(+{pct}%)")
                else:
                    instructions.append(f"预算 ${budget:.2f}→${new_budget:.2f}(+{pct}%)")
        
        # ROI 正常，维持
        elif roi >= 50:
            if cpc > 0 and budget > 0:
                return f"CPC ${cpc:.2f}→${cpc:.2f} | 预算 ${budget:.2f}→${budget:.2f}(+0%)"
            return "稳定运行"
        
        # 样本不足
        else:
            return "样本不足"
        
        # 组合指令
        if instructions:
            return " | ".join(instructions)
        return "稳定运行"
    
    def generate_l7d_analysis(
        self,
        end_date: date,
        user_id: Optional[int] = None
    ) -> Dict:
        """生成L7D分析 - 按广告系列展示"""
        begin_date = end_date - timedelta(days=6)
        logger.info(f"=== 开始生成L7D分析 === 范围: {begin_date} ~ {end_date}")
        
        try:
            # 预加载MCC货币配置（用于人民币转美金）
            from app.models.google_ads_api_data import GoogleMccAccount
            from app.config import settings
            
            CNY_TO_USD_RATE = float(getattr(settings, "CNY_TO_USD_RATE", 7.2) or 7.2)
            
            # 获取所有MCC的货币配置
            mcc_currency_map = {}  # {mcc_id: currency}
            all_mccs = self.db.query(GoogleMccAccount).all()
            for mcc in all_mccs:
                mcc_currency_map[mcc.id] = getattr(mcc, 'currency', 'USD') or 'USD'
            
            def convert_to_usd(amount: float, currency: str) -> float:
                """将金额转换为美元"""
                if currency and currency.upper() == "CNY":
                    return amount / CNY_TO_USD_RATE
                return amount
            
            query = self.db.query(GoogleAdsApiData).filter(
                GoogleAdsApiData.date >= begin_date,
                GoogleAdsApiData.date <= end_date,
                GoogleAdsApiData.status == "ENABLED"  # 只分析已启用的广告
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
                
                # 获取该MCC的货币类型
                mcc_currency = mcc_currency_map.get(data.mcc_id, "USD")
                
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
                        "currency": mcc_currency,  # 记录货币类型
                        "data_dates": set(),  # 有数据的天数
                        "total_cost": 0.0,
                        "total_clicks": 0,
                        "max_cpc": 0.0,
                        "max_budget": 0.0,  # 预算
                        "is_budget_lost": 0.0,
                        "is_rank_lost": 0.0,
                    }
                # 记录有数据的日期
                campaign_data[key]["data_dates"].add(data.date)
                # 费用、CPC、预算需要进行货币转换（人民币转美金）
                campaign_data[key]["total_cost"] += convert_to_usd(data.cost or 0, mcc_currency)
                campaign_data[key]["total_clicks"] += int(data.clicks or 0)
                campaign_data[key]["max_cpc"] = max(campaign_data[key]["max_cpc"], convert_to_usd(data.cpc or 0, mcc_currency))
                campaign_data[key]["max_budget"] = max(campaign_data[key]["max_budget"], convert_to_usd(data.budget or 0, mcc_currency))
                campaign_data[key]["is_budget_lost"] = max(campaign_data[key]["is_budget_lost"], (data.is_budget_lost or 0))
                campaign_data[key]["is_rank_lost"] = max(campaign_data[key]["is_rank_lost"], (data.is_rank_lost or 0))
            
            # 预加载商家佣金数据（支持 MID 匹配 和 商家名匹配）
            from sqlalchemy import func, or_
            from app.models.affiliate_transaction import AffiliateTransaction
            
            # 获取所有涉及的用户ID
            user_ids = set(cdata["user_id"] for cdata in campaign_data.values())
            
            # 收集所有 MID
            mids = set(str(cdata.get("mid")) for cdata in campaign_data.values() if cdata.get("mid"))
            logger.info(f"用户IDs: {user_ids}, 商家MIDs: {mids}")
            
            # 预查询：获取该用户所有商家的 L7D 佣金和订单（只按 MID 分组）
            merchant_l7d_data = {}  # {(user_id, mid): {commission, orders, order_days}}
            
            for uid in user_ids:
                # 查询该用户的所有交易，只按 merchant_id (MID) 分组
                # 排除已删除/停用账号的交易
                txn_results = self.db.query(
                    AffiliateTransaction.merchant_id,
                    func.sum(AffiliateTransaction.commission_amount).label('total_commission'),
                    func.count(AffiliateTransaction.id).label('total_orders'),
                    func.count(func.distinct(func.date(AffiliateTransaction.transaction_time))).label('order_days')
                ).outerjoin(
                    AffiliateAccount,
                    AffiliateTransaction.affiliate_account_id == AffiliateAccount.id
                ).filter(
                    AffiliateTransaction.user_id == uid,
                    AffiliateTransaction.merchant_id.isnot(None),  # 只查有 MID 的
                    AffiliateTransaction.merchant_id != 'None',
                    func.date(AffiliateTransaction.transaction_time) >= begin_date,
                    func.date(AffiliateTransaction.transaction_time) <= end_date,
                    # 排除已删除/停用账号的交易（账号不存在或已停用）
                    (AffiliateAccount.id.is_(None)) | (AffiliateAccount.is_active == True)
                ).group_by(
                    AffiliateTransaction.merchant_id
                ).all()
                
                for txn in txn_results:
                    mid = str(txn.merchant_id).strip()
                    merchant_l7d_data[(uid, mid)] = {
                        "commission": float(txn.total_commission or 0),
                        "orders": int(txn.total_orders or 0),
                        "order_days": int(txn.order_days or 0)
                    }
                    logger.info(f"L7D 商家数据: user={uid}, MID={mid}, 佣金={txn.total_commission}, 订单={txn.total_orders}")
            
            # 按用户分组生成结果
            user_results = {}
            for key, cdata in campaign_data.items():
                data_user_id = cdata["user_id"]
                mid = cdata.get("mid")  # 商家ID（从广告系列名提取）
                
                # 只用 MID 匹配，不用商家名匹配
                merchant_info = {}
                if mid:
                    merchant_info = merchant_l7d_data.get((data_user_id, str(mid)), {})
                    if merchant_info:
                        logger.info(f"MID匹配成功: 广告系列MID={mid}, 佣金={merchant_info.get('commission')}")
                
                commission = merchant_info.get("commission", 0.0)
                orders = merchant_info.get("orders", 0)
                order_days = merchant_info.get("order_days", 0)
                
                # 计算保守EPC和保守ROI
                cost = cdata["total_cost"]
                clicks = cdata["total_clicks"]
                data_days = len(cdata["data_dates"])  # 有Google Ads数据的天数
                
                # 过滤掉没有数据的广告系列（点击=0 且 花费=0 且 佣金=0）
                if clicks == 0 and cost == 0 and commission == 0:
                    continue
                
                conservative_epc = (commission * 0.72 / clicks) if clicks > 0 else 0
                conservative_roi = ((commission * 0.72 - cost) / cost) if cost > 0 else None
                
                # 生成操作指令
                operation = self._generate_l7d_operation(
                    conservative_roi, cdata["is_budget_lost"], cdata["is_rank_lost"], 
                    order_days, cdata["max_cpc"], orders, cdata["max_budget"]
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
                    "campaign_id": cdata["campaign_id"],  # 用于前端查询出价策略
                    "预算": round(cdata["max_budget"], 2),
                    "IS Budget丢失": f"{cdata['is_budget_lost'] * 100:.1f}%" if cdata['is_budget_lost'] > 0 else "-",
                    "IS Rank丢失": f"{cdata['is_rank_lost'] * 100:.1f}%" if cdata['is_rank_lost'] > 0 else "-",
                    "保守EPC": round(conservative_epc, 4),
                    "保守ROI": f"{conservative_roi * 100:.1f}%" if conservative_roi is not None else "-",
                    "操作指令": operation,
                    "ai_report": "",  # 将在后面批量生成
                }
                
                if data_user_id not in user_results:
                    user_results[data_user_id] = []
                user_results[data_user_id].append(row)
            
            # 为每个用户批量生成 AI 分析报告
            for data_user_id, rows in user_results.items():
                if not rows:
                    continue
                try:
                    # 获取用户自定义提示词
                    user_prompt = self.db.query(UserPrompt).filter(
                        UserPrompt.user_id == data_user_id
                    ).first()
                    custom_prompt = user_prompt.prompt if user_prompt else None
                    
                    # 批量调用 AI 生成分析报告
                    ai_reports = self._generate_batch_ai_reports(rows, custom_prompt)
                    
                    # 将 AI 报告分配到每条记录
                    for row in rows:
                        campaign_name = row.get("广告系列名", "")
                        row["ai_report"] = ai_reports.get(campaign_name, "")
                except Exception as e:
                    logger.error(f"为用户 {data_user_id} 生成 AI 报告失败: {e}")
                    # AI 报告生成失败不影响主流程，继续保存
            
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
    
    
    def _generate_l7d_operation(
        self,
        conservative_roi: Optional[float],
        is_budget_lost: float,
        is_rank_lost: float,
        order_days: int,
        max_cpc: float,
        orders: int,
        budget: float = 0
    ) -> str:
        """
        生成L7D操作指令
        格式: CPC $X.XX→$X.XX | 预算 $X.XX→$X.XX(+X%)
        """
        cpc = max_cpc
        
        # ROI判断 - 严重亏损直接关停
        if conservative_roi is not None and conservative_roi < -0.4:
            return "关停"
        
        # ROI为负，降价
        if conservative_roi is not None and conservative_roi < 0:
            if cpc > 0:
                new_cpc = max(0.01, cpc - 0.05)
                return f"CPC ${cpc:.2f}→${new_cpc:.2f}"
            return "关停"
        
        # ROI优秀（>=100%）且有预算瓶颈，加预算
        if conservative_roi is not None and conservative_roi >= 1.0:
            instructions = []
            
            # 预算瓶颈 - 加预算
            if is_budget_lost > 0.2 and order_days >= 4:
                if budget > 0 and cpc > 0:
                    new_budget = budget * 1.3
                    instructions.append(f"CPC ${cpc:.2f}→${cpc:.2f} | 预算 ${budget:.2f}→${new_budget:.2f}(+30%)")
                elif budget > 0:
                    new_budget = budget * 1.3
                    instructions.append(f"预算 ${budget:.2f}→${new_budget:.2f}(+30%)")
                else:
                    instructions.append("加预算")
            
            # 排名瓶颈 - 提高CPC
            elif is_rank_lost > 0.15:
                if cpc > 0:
                    new_cpc = cpc + 0.02
                    if budget > 0:
                        instructions.append(f"CPC ${cpc:.2f}→${new_cpc:.2f} | 预算 ${budget:.2f}→${budget:.2f}(+0%)")
                    else:
                        instructions.append(f"CPC ${cpc:.2f}→${new_cpc:.2f}")
                else:
                    instructions.append("提高CPC")
            
            if instructions:
                return " | ".join(instructions)
            
            # 状态稳定
            if cpc > 0 and budget > 0:
                return f"CPC ${cpc:.2f}→${cpc:.2f} | 预算 ${budget:.2f}→${budget:.2f}(+0%)"
            return "稳定运行"
        
        # ROI中等（50%-100%），有预算瓶颈时加预算
        if conservative_roi is not None and conservative_roi >= 0.5:
            if is_budget_lost > 0.3 and budget > 0:
                new_budget = budget * 1.2
                if cpc > 0:
                    return f"CPC ${cpc:.2f}→${cpc:.2f} | 预算 ${budget:.2f}→${new_budget:.2f}(+20%)"
                return f"预算 ${budget:.2f}→${new_budget:.2f}(+20%)"
            if cpc > 0 and budget > 0:
                return f"CPC ${cpc:.2f}→${cpc:.2f} | 预算 ${budget:.2f}→${budget:.2f}(+0%)"
            return "稳定运行"
        
        # 出单情况 - 无出单则样本不足
        if order_days == 0 and orders == 0:
            return "样本不足"
        
        return "稳定运行"
    
    def _generate_batch_ai_reports(
        self,
        rows: List[Dict],
        custom_prompt: Optional[str] = None
    ) -> Dict[str, str]:
        """
        批量生成 AI 分析报告
        
        Args:
            rows: 广告系列数据列表
            custom_prompt: 用户自定义提示词
        
        Returns:
            {campaign_name: ai_report} 的字典
        """
        from app.services.gemini_service import GeminiService
        from app.config import settings
        
        # 获取 Gemini 配置
        api_key = getattr(settings, 'gemini_api_key', None)
        if not api_key:
            logger.warning("Gemini API 密钥未配置，跳过 AI 报告生成")
            return {}
        
        base_url = getattr(settings, 'gemini_base_url', None) or "https://api.gemai.cc/v1beta"
        model = getattr(settings, 'gemini_model_thinking', "gemini-3-flash-preview-thinking")
        
        try:
            service = GeminiService(api_key, base_url, model)
            
            # 准备数据
            campaigns_data = []
            for row in rows:
                # 解析百分比格式
                budget_lost = row.get("IS Budget丢失", "0")
                rank_lost = row.get("IS Rank丢失", "0")
                roi = row.get("保守ROI", "0")
                
                if isinstance(budget_lost, str):
                    budget_lost = float(budget_lost.replace("%", "").replace("-", "0") or 0) / 100
                if isinstance(rank_lost, str):
                    rank_lost = float(rank_lost.replace("%", "").replace("-", "0") or 0) / 100
                if isinstance(roi, str):
                    roi = float(roi.replace("%", "").replace("-", "0") or 0) / 100
                
                campaigns_data.append({
                    "campaign_name": row.get("广告系列名", ""),
                    "cost": row.get("L7D花费", 0),
                    "clicks": row.get("L7D点击", 0),
                    "impressions": 0,  # L7D 分析中没有展示数据
                    "cpc": row.get("当前Max CPC", 0),
                    "budget": 0,  # 需要从其他地方获取
                    "conservative_epc": row.get("保守EPC", 0),
                    "is_budget_lost": budget_lost,
                    "is_rank_lost": rank_lost,
                    "orders": 0,  # L7D 分析中没有单独的订单字段
                    "order_days": row.get("L7D出单天数", 0),
                    "commission": row.get("L7D佣金", 0)
                })
            
            # 调用 AI 生成报告
            result = service.generate_operation_report(campaigns_data, custom_prompt)
            
            if not result.get("success"):
                logger.error(f"AI 报告生成失败: {result.get('message')}")
                return {}
            
            # 解析 AI 返回的报告，按广告系列名拆分
            full_report = result.get("analysis", "")
            return self._parse_ai_report_by_campaign(full_report, rows)
            
        except Exception as e:
            logger.error(f"批量生成 AI 报告异常: {e}", exc_info=True)
            return {}
    
    def _parse_ai_report_by_campaign(
        self,
        full_report: str,
        rows: List[Dict]
    ) -> Dict[str, str]:
        """
        解析 AI 报告，按广告系列名拆分
        
        解析策略：
        1. 使用 "###" 分割报告段落
        2. 对每个段落提取广告系列名（考虑各种格式变体）
        3. 用模糊匹配找到对应的原始广告系列名
        
        Args:
            full_report: AI 生成的完整报告
            rows: 广告系列数据列表
        
        Returns:
            {campaign_name: ai_report} 的字典
        """
        reports = {}
        
        # 收集所有广告系列名
        campaign_names = [row.get("广告系列名", "") for row in rows if row.get("广告系列名")]
        
        if not campaign_names or not full_report:
            return reports
        
        # 创建广告系列名的简化版本用于匹配（去除常见变体）
        def simplify_name(name: str) -> str:
            """简化广告系列名用于匹配"""
            if not name:
                return ""
            # 去除空白、表情符号，转小写
            import unicodedata
            simplified = name.strip().lower()
            # 移除表情符号
            simplified = re.sub(r'[📊🔶🔷💎⭐🎯📈📉✅❌⚠️🔴🟡🟢💰☕▲🏆✨🌱📉]', '', simplified)
            # 移除括号及其内容（如 (成熟期)）
            simplified = re.sub(r'\s*[\(（][^)）]*[\)）]\s*', '', simplified)
            # 保留字母数字和连字符
            simplified = re.sub(r'[^a-z0-9\-]', '', simplified)
            return simplified.strip()
        
        # 建立简化名 -> 原始名的映射
        name_map = {}
        for name in campaign_names:
            simple = simplify_name(name)
            if simple:
                name_map[simple] = name
        
        # 按 "###" 分割报告，保留每个段落直到下一个 "###"
        # 使用正则匹配 ### 开头的行（三级标题）
        sections = re.split(r'(?=^###\s|\n###\s)', full_report)
        
        # 跳过第一个段落（通常是概述/总览）
        overview_content = ""
        campaign_sections = []
        
        for section in sections:
            section = section.strip()
            if not section:
                continue
            
            # 检查是否是广告系列标题（以 ### 开头）
            if section.startswith('###'):
                # 提取第一行（标题行）
                first_line = section.split('\n')[0] if '\n' in section else section
                title_text = first_line.replace('###', '').strip()
                
                # 检查是否是数字开头的子标题（如 "### 1. 阶段评价"）
                if re.match(r'^\d+\.\s', title_text):
                    # 这是子标题，附加到上一个广告系列
                    if campaign_sections:
                        campaign_sections[-1]['content'] += '\n\n' + section
                    continue
                
                # 检查是否是总览/概览类标题
                if any(keyword in title_text for keyword in ['概览', '总览', '总结', '节奏', '执行清单', '综述', '专项名单']):
                    overview_content += '\n\n' + section
                    continue
                
                # 这是一个新的广告系列段落
                campaign_sections.append({
                    'title_text': title_text,
                    'content': section
                })
            else:
                # 非 ### 开头的内容属于概述
                if not campaign_sections:
                    overview_content += section + '\n'
        
        # 将每个段落匹配到对应的广告系列
        for cs in campaign_sections:
            title_text = cs['title_text']
            content = cs['content']
            
            # 尝试找到匹配的广告系列名
            matched_name = None
            
            # 方法1: 直接匹配（广告系列名完整出现在标题中）
            for name in campaign_names:
                if name in title_text:
                    matched_name = name
                    break
            
            # 方法2: 简化匹配
            if not matched_name:
                simple_title = simplify_name(title_text)
                if simple_title in name_map:
                    matched_name = name_map[simple_title]
                else:
                    # 尝试部分匹配
                    for simple, original in name_map.items():
                        # 如果标题包含简化的广告系列名（至少10个字符匹配）
                        if len(simple) >= 10 and simple in simple_title:
                            matched_name = original
                            break
                        if len(simple_title) >= 10 and simple_title in simple:
                            matched_name = original
                            break
            
            # 方法3: 更宽松的匹配 - 提取广告系列名中的核心部分
            if not matched_name:
                # 提取标题中看起来像广告系列名的部分（如 181-CG1-uaudio-US）
                campaign_pattern = re.search(r'\d+-[A-Z0-9]+-[a-zA-Z0-9]+-[A-Z]{2}', title_text, re.IGNORECASE)
                if campaign_pattern:
                    extracted = campaign_pattern.group()
                    for name in campaign_names:
                        if extracted.lower() in name.lower() or name.lower().startswith(extracted.lower()):
                            matched_name = name
                            break
            
            if matched_name:
                # 如果已有内容，合并（处理分成多段的情况）
                if matched_name in reports:
                    reports[matched_name] += '\n\n' + content
                else:
                    reports[matched_name] = content
        
        # 对于没有匹配上的广告系列，返回完整报告
        # 但先标记一下，加个提示
        if full_report:
            for name in campaign_names:
                if name not in reports:
                    # 生成一个带提示的报告
                    reports[name] = f"### 📊 {name}\n\n该广告系列的分析报告可能包含在完整报告中。\n\n---\n\n{full_report}"
        
        logger.info(f"AI报告解析完成: 共{len(campaign_names)}个广告系列, 成功匹配{len([n for n in campaign_names if n in reports and '该广告系列的分析报告可能包含在完整报告中' not in reports.get(n, '')])}个")
        
        return reports
