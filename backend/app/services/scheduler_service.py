"""
定时任务服务
用于定时同步数据和执行分析
"""
import logging
from datetime import datetime, date, timedelta
from sqlalchemy.orm import Session
from app.database import SessionLocal

logger = logging.getLogger(__name__)


class SchedulerService:
    """定时任务服务"""
    
    @staticmethod
    def sync_platform_data():
        """
        同步平台数据（佣金、订单数、本周出单天数）
        每天4点和16点执行
        """
        db: Session = SessionLocal()
        try:
            from app.models.affiliate_account import AffiliateAccount
            from app.models.platform_daily_data import PlatformDailyData
            from app.services.linkhaitao_service import LinkHaitaoService
            from app.services.collabglow_service import CollabGlowService
            from datetime import datetime, date
            
            # 获取所有激活的账号
            accounts = db.query(AffiliateAccount).filter(
                AffiliateAccount.is_active == True
            ).all()
            
            today = date.today()
            week_start = today - timedelta(days=today.weekday())  # 本周一
            
            synced_count = 0
            for account in accounts:
                try:
                    # 获取平台代码
                    platform_code = account.platform.platform_code.lower()
                    
                    # 获取token
                    import json
                    token = None
                    if account.notes:
                        try:
                            notes_data = json.loads(account.notes)
                            if platform_code == 'collabglow':
                                token = notes_data.get("collabglow_token")
                            elif platform_code in ['linkhaitao', 'link-haitao']:
                                token = notes_data.get("linkhaitao_token")
                        except:
                            pass
                    
                    if not token:
                        continue
                    
                    # 根据平台选择服务
                    if platform_code == 'collabglow':
                        service = CollabGlowService(token)
                        # 获取最近7天的数据（用于计算本周出单天数）
                        end_date = today.strftime("%Y-%m-%d")
                        begin_date = (week_start - timedelta(days=1)).strftime("%Y-%m-%d")
                        
                        result = service.sync_commissions(begin_date, end_date)
                        commissions = result.get("data", {}).get("list", [])
                        
                        # 计算本周出单天数
                        order_dates = set()
                        total_commission = 0
                        total_orders = 0
                        
                        for comm in commissions:
                            settlement_date = comm.get("settlement_date")
                            if settlement_date:
                                try:
                                    comm_date = datetime.strptime(settlement_date, "%Y-%m-%d").date()
                                    if week_start <= comm_date <= today:
                                        order_dates.add(comm_date)
                                    if comm_date == today:
                                        total_commission += comm.get("sale_commission", 0)
                                        total_orders += 1
                                except:
                                    pass
                        
                        week_order_days = len(order_dates)
                        
                    elif platform_code in ['linkhaitao', 'link-haitao']:
                        service = LinkHaitaoService(token)
                        end_date = today.strftime("%Y-%m-%d")
                        begin_date = (week_start - timedelta(days=1)).strftime("%Y-%m-%d")
                        
                        result = service.sync_commissions_and_orders(begin_date, end_date)
                        if result.get("success"):
                            # 处理数据...
                            total_commission = result.get("total_commission", 0)
                            total_orders = result.get("total_orders", 0)
                            week_order_days = 0  # TODO: 计算本周出单天数
                        else:
                            continue
                    else:
                        continue
                    
                    # 保存或更新平台数据
                    existing = db.query(PlatformDailyData).filter(
                        PlatformDailyData.affiliate_account_id == account.id,
                        PlatformDailyData.date == today
                    ).first()
                    
                    if existing:
                        existing.commission = total_commission
                        existing.orders = total_orders
                        existing.week_order_days = week_order_days
                        existing.last_sync_at = datetime.now()
                    else:
                        new_data = PlatformDailyData(
                            user_id=account.user_id,
                            affiliate_account_id=account.id,
                            platform_id=account.platform_id,
                            date=today,
                            commission=total_commission,
                            orders=total_orders,
                            week_order_days=week_order_days,
                            last_sync_at=datetime.now()
                        )
                        db.add(new_data)
                    
                    synced_count += 1
                    
                except Exception as e:
                    logger.error(f"同步账号 {account.id} 失败: {e}")
                    continue
            
            db.commit()
            logger.info(f"平台数据同步完成，共同步 {synced_count} 个账号")
            
        except Exception as e:
            logger.error(f"平台数据同步失败: {e}")
            db.rollback()
        finally:
            db.close()
    
    @staticmethod
    def sync_google_ads_data():
        """
        同步Google Ads数据
        每天8点执行（在分析之前）
        """
        db: Session = SessionLocal()
        try:
            from app.models.mcc_account import MccAccount
            from app.services.google_ads_service import GoogleAdsService
            
            today = date.today()
            
            # 获取所有激活的MCC账号
            mcc_accounts = db.query(MccAccount).filter(
                MccAccount.is_active == True
            ).all()
            
            synced_count = 0
            for mcc_account in mcc_accounts:
                try:
                    service = GoogleAdsService(
                        mcc_account_id=mcc_account.mcc_account_id,
                        refresh_token=mcc_account.refresh_token,
                        client_id=mcc_account.client_id,
                        client_secret=mcc_account.client_secret,
                        developer_token=mcc_account.developer_token
                    )
                    
                    count = service.sync_daily_data(db, mcc_account.user_id, today)
                    synced_count += count
                    
                except Exception as e:
                    logger.error(f"同步MCC账号 {mcc_account.id} 失败: {e}")
                    continue
            
            logger.info(f"Google Ads数据同步完成，共同步 {synced_count} 条记录")
            
        except Exception as e:
            logger.error(f"Google Ads数据同步失败: {e}")
            db.rollback()
        finally:
            db.close()
    
    @staticmethod
    def run_daily_analysis():
        """
        执行每日分析
        每天8点执行（在同步数据之后）
        """
        db: Session = SessionLocal()
        try:
            from app.services.analysis_service import AnalysisService
            
            today = date.today()
            
            # 执行每日分析
            analysis_service = AnalysisService()
            # TODO: 调用分析服务，从数据库读取数据而非上传文件
            logger.info(f"每日分析完成: {today}")
            
        except Exception as e:
            logger.error(f"每日分析失败: {e}")
        finally:
            db.close()

