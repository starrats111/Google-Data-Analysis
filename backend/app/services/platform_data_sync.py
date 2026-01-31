"""
平台数据同步服务
从平台API同步佣金、订单等数据
"""
from datetime import datetime, date, timedelta
from typing import List, Dict, Optional
from sqlalchemy.orm import Session
import json
import logging

from app.models.platform_data import PlatformData
from app.models.affiliate_account import AffiliateAccount
from app.services.collabglow_service import CollabGlowService
from app.services.linkhaitao_service import LinkHaitaoService

logger = logging.getLogger(__name__)


class PlatformDataSyncService:
    """平台数据同步服务"""
    
    def __init__(self, db: Session):
        self.db = db
    
    def sync_account_data(
        self,
        account_id: int,
        begin_date: str,
        end_date: str,
        token: Optional[str] = None
    ) -> Dict:
        """
        同步指定账号的平台数据
        
        Args:
            account_id: 联盟账号ID
            begin_date: 开始日期 YYYY-MM-DD
            end_date: 结束日期 YYYY-MM-DD
        
        Returns:
            同步结果
        """
        from sqlalchemy.orm import joinedload
        
        account = self.db.query(AffiliateAccount).options(
            joinedload(AffiliateAccount.platform)
        ).filter(
            AffiliateAccount.id == account_id
        ).first()
        
        if not account:
            return {"success": False, "message": "账号不存在"}
        
        if not account.platform:
            return {"success": False, "message": "账号关联的平台不存在"}
        
        platform_code = account.platform.platform_code.lower() if account.platform.platform_code else ""
        platform_name = account.platform.platform_name or "未知平台"
        platform_url = getattr(account.platform, 'description', '') or ''
        
        logger.info(f"同步账号 {account.account_name} (ID: {account_id})")
        logger.info(f"平台信息 - 代码(原始): {account.platform.platform_code}, 代码(小写): {platform_code}, 名称: {platform_name}, URL: {platform_url}")
        
        # 根据平台类型选择不同的服务
        # 支持多种平台代码格式（不区分大小写）
        platform_code_normalized = platform_code.strip()
        platform_name_normalized = platform_name.strip().lower()
        
        # 识别逻辑：同时检查平台代码和平台名称
        # 因为有些平台的platform_code可能是URL而不是代码
        is_collabglow = (
            platform_code_normalized in ["collabglow", "cg", "collab-glow", "collab_glow"] or
            platform_name_normalized in ["cg", "collabglow", "collab-glow"] or
            "collabglow" in platform_code_normalized or
            "collabglow" in platform_name_normalized
        )
        
        is_linkhaitao = (
            platform_code_normalized in ["linkhaitao", "link-haitao", "lh", "link_haitao"] or
            platform_name_normalized in ["lh", "linkhaitao", "link-haitao"] or
            "linkhaitao" in platform_code_normalized or
            "linkhaitao" in platform_name_normalized
        )
        
        if is_collabglow:
            logger.info(f"✓ 识别为CollabGlow平台，开始同步...")
            return self._sync_collabglow_data(account, begin_date, end_date, token)
        elif is_linkhaitao:
            logger.info(f"✓ 识别为LinkHaitao平台，开始同步...")
            return self._sync_linkhaitao_data(account, begin_date, end_date, token)
        else:
            # 对于其他平台，尝试从notes中读取通用API配置
            # 如果平台有API token配置，可以在这里扩展支持
            logger.warning(f"✗ 未识别的平台代码: '{platform_code_normalized}' (原始: '{account.platform.platform_code}'), 平台名称: {platform_name}")
            error_msg = f"平台 {platform_name}"
            if platform_url:
                error_msg += f" ({platform_url})"
            error_msg += f" 的API集成尚未实现。请联系管理员添加该平台的API支持。"
            return {"success": False, "message": error_msg}
    
    def _sync_collabglow_data(
        self,
        account: AffiliateAccount,
        begin_date: str,
        end_date: str,
        token: Optional[str] = None
    ) -> Dict:
        """同步CollabGlow数据"""
        try:
            # 获取token：优先使用传入的token，如果没有则从账号备注中读取
            import json
            if not token:
                if account.notes:
                    try:
                        notes_data = json.loads(account.notes)
                        token = notes_data.get("collabglow_token")
                    except:
                        pass
            
            if not token:
                return {"success": False, "message": "未配置CollabGlow Token。请在同步对话框中输入Token，或在账号编辑页面的备注中配置。"}
            
            # 同步数据
            service = CollabGlowService(token=token)
            result = service.sync_commissions(begin_date, end_date)
            
            commissions = result.get("data", {}).get("list", [])
            
            # 保存到数据库
            saved_count = 0
            for comm in commissions:
                settlement_date = comm.get("settlement_date")
                if not settlement_date:
                    continue
                
                try:
                    comm_date = datetime.strptime(settlement_date, "%Y-%m-%d").date()
                    
                    # 查找或创建记录
                    platform_data = self.db.query(PlatformData).filter(
                        PlatformData.affiliate_account_id == account.id,
                        PlatformData.date == comm_date
                    ).first()
                    
                    if not platform_data:
                        platform_data = PlatformData(
                            affiliate_account_id=account.id,
                            user_id=account.user_id,
                            date=comm_date,
                            commission=comm.get("sale_commission", 0),
                            orders=0,  # CollabGlow API不提供订单数
                            order_days_this_week=0
                        )
                        self.db.add(platform_data)
                    else:
                        platform_data.commission = comm.get("sale_commission", 0)
                        platform_data.last_sync_at = datetime.now()
                    
                    saved_count += 1
                except Exception as e:
                    logger.error(f"保存CollabGlow数据失败: {e}")
                    continue
            
            self.db.commit()
            
            return {
                "success": True,
                "message": f"成功同步 {saved_count} 条记录",
                "saved_count": saved_count
            }
            
        except Exception as e:
            self.db.rollback()
            logger.error(f"同步CollabGlow数据失败: {e}")
            return {"success": False, "message": f"同步失败: {str(e)}"}
    
    def _sync_linkhaitao_data(
        self,
        account: AffiliateAccount,
        begin_date: str,
        end_date: str
    ) -> Dict:
        """同步LinkHaitao数据"""
        try:
            # 获取token
            import json
            token = None
            if account.notes:
                try:
                    notes_data = json.loads(account.notes)
                    token = notes_data.get("linkhaitao_token") or notes_data.get("token")
                except:
                    pass
            
            if not token:
                return {"success": False, "message": "未配置LinkHaitao Token"}
            
            # 同步数据
            service = LinkHaitaoService(token=token)
            result = service.sync_commissions_and_orders(begin_date, end_date)
            
            if not result.get("success"):
                return result
            
            data = result.get("data", {})
            commissions = data.get("commissions", [])
            orders = data.get("orders", [])
            
            # 按日期聚合数据
            date_data = {}
            
            # 处理佣金数据
            for comm in commissions:
                settlement_date = comm.get("settlement_date")
                if not settlement_date:
                    continue
                
                try:
                    comm_date = datetime.strptime(settlement_date, "%Y-%m-%d").date()
                    if comm_date not in date_data:
                        date_data[comm_date] = {
                            "commission": 0,
                            "orders": [],
                            "order_count": 0
                        }
                    date_data[comm_date]["commission"] += comm.get("commission", 0)
                except:
                    continue
            
            # 处理订单数据
            for order in orders:
                order_date_str = order.get("date") or order.get("order_date")
                if not order_date_str:
                    continue
                
                try:
                    order_date = datetime.strptime(order_date_str, "%Y-%m-%d").date()
                    if order_date not in date_data:
                        date_data[order_date] = {
                            "commission": 0,
                            "orders": [],
                            "order_count": 0
                        }
                    date_data[order_date]["orders"].append(order)
                    date_data[order_date]["order_count"] += 1
                except:
                    continue
            
            # 保存到数据库
            saved_count = 0
            for comm_date, data_item in date_data.items():
                try:
                    platform_data = self.db.query(PlatformData).filter(
                        PlatformData.affiliate_account_id == account.id,
                        PlatformData.date == comm_date
                    ).first()
                    
                    if not platform_data:
                        platform_data = PlatformData(
                            affiliate_account_id=account.id,
                            user_id=account.user_id,
                            date=comm_date,
                            commission=data_item["commission"],
                            orders=data_item["order_count"],
                            order_days_this_week=0,  # 需要计算本周出单天数
                            order_details=json.dumps(data_item["orders"]) if data_item["orders"] else None
                        )
                        self.db.add(platform_data)
                    else:
                        platform_data.commission = data_item["commission"]
                        platform_data.orders = data_item["order_count"]
                        platform_data.order_details = json.dumps(data_item["orders"]) if data_item["orders"] else None
                        platform_data.last_sync_at = datetime.now()
                    
                    saved_count += 1
                except Exception as e:
                    logger.error(f"保存LinkHaitao数据失败: {e}")
                    continue
            
            self.db.commit()
            
            return {
                "success": True,
                "message": f"成功同步 {saved_count} 条记录",
                "saved_count": saved_count
            }
            
        except Exception as e:
            self.db.rollback()
            logger.error(f"同步LinkHaitao数据失败: {e}")
            return {"success": False, "message": f"同步失败: {str(e)}"}
    
    def calculate_weekly_order_days(self, account_id: int, target_date: date) -> int:
        """
        计算指定日期所在周的出单天数
        
        Args:
            account_id: 联盟账号ID
            target_date: 目标日期
        
        Returns:
            本周出单天数
        """
        # 计算本周的开始日期（周一）
        days_since_monday = target_date.weekday()
        week_start = target_date - timedelta(days=days_since_monday)
        week_end = week_start + timedelta(days=6)
        
        # 查询本周有订单的日期
        order_dates = self.db.query(PlatformData.date).filter(
            PlatformData.affiliate_account_id == account_id,
            PlatformData.date >= week_start,
            PlatformData.date <= week_end,
            PlatformData.orders > 0
        ).distinct().all()
        
        return len(order_dates)
    
    def update_weekly_order_days(self, account_id: int, target_date: date):
        """更新指定日期所在周的所有记录的本周出单天数"""
        days_since_monday = target_date.weekday()
        week_start = target_date - timedelta(days=days_since_monday)
        week_end = week_start + timedelta(days=6)
        
        order_days = self.calculate_weekly_order_days(account_id, target_date)
        
        # 更新本周所有记录
        self.db.query(PlatformData).filter(
            PlatformData.affiliate_account_id == account_id,
            PlatformData.date >= week_start,
            PlatformData.date <= week_end
        ).update({
            PlatformData.order_days_this_week: order_days
        })
        
        self.db.commit()


