"""
数据完整性检查脚本
检查所有 MCC 的 Google Ads 数据 + 所有平台的交易数据完整性
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datetime import date, timedelta
from collections import defaultdict
from sqlalchemy import func, distinct
from app.database import SessionLocal
from app.models.google_ads_api_data import GoogleAdsApiData, GoogleMccAccount
from app.models.affiliate_transaction import AffiliateTransaction
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.user import User


def check_mcc_data(db):
    print("=" * 70)
    print("  一、Google Ads MCC 数据完整性")
    print("=" * 70)

    mccs = db.query(GoogleMccAccount).order_by(GoogleMccAccount.is_active.desc(), GoogleMccAccount.id).all()
    if not mccs:
        print("  (无 MCC 账号)")
        return

    today = date.today()
    check_begin = date(2026, 2, 1)
    check_end = today - timedelta(days=1)

    for mcc in mccs:
        status_tag = "活跃" if mcc.is_active else "停用"
        print(f"\n  [{status_tag}] {mcc.mcc_name} (ID: {mcc.mcc_id}, 货币: {mcc.currency})")
        print(f"       同步状态: {mcc.last_sync_status or '未同步'}  |  最后同步: {mcc.last_sync_at or 'N/A'}")
        print(f"       广告系列: {mcc.total_campaigns}  |  客户账号: {mcc.total_customers}")

        if not mcc.is_active:
            print(f"       (已停用，跳过数据检查)")
            continue

        # 查询该 MCC 有数据的日期
        date_rows = db.query(
            GoogleAdsApiData.date,
            func.count(GoogleAdsApiData.id),
            func.sum(GoogleAdsApiData.cost)
        ).filter(
            GoogleAdsApiData.mcc_id == mcc.id,
            GoogleAdsApiData.date >= check_begin,
            GoogleAdsApiData.date <= check_end
        ).group_by(GoogleAdsApiData.date).all()

        existing_dates = {row[0] for row in date_rows}
        total_records = sum(row[1] for row in date_rows)
        total_cost = sum(row[2] or 0 for row in date_rows)

        # 生成完整日期列表
        all_dates = []
        d = check_begin
        while d <= check_end:
            all_dates.append(d)
            d += timedelta(days=1)

        missing = [d for d in all_dates if d not in existing_dates]

        print(f"       检查范围: {check_begin} ~ {check_end} ({len(all_dates)} 天)")
        print(f"       已有数据: {len(existing_dates)} 天  |  记录数: {total_records}  |  总花费: ${total_cost:,.2f}")

        if missing:
            print(f"       ⚠ 缺失 {len(missing)} 天:")
            # 将缺失日期分组显示（连续的合并）
            ranges = []
            start = missing[0]
            prev = missing[0]
            for d in missing[1:]:
                if (d - prev).days == 1:
                    prev = d
                else:
                    ranges.append((start, prev))
                    start = d
                    prev = d
            ranges.append((start, prev))

            for s, e in ranges:
                if s == e:
                    print(f"         - {s}")
                else:
                    print(f"         - {s} ~ {e} ({(e - s).days + 1} 天)")
        else:
            print(f"       ✓ 数据完整，无缺失")

        # 最近 7 天每天的记录数
        print(f"       最近7天明细:")
        recent_start = today - timedelta(days=7)
        recent_rows = {row[0]: (row[1], row[2] or 0) for row in date_rows if row[0] >= recent_start}
        for i in range(7, 0, -1):
            d = today - timedelta(days=i)
            if d in recent_rows:
                cnt, cost = recent_rows[d]
                print(f"         {d}: {cnt} 条, ${cost:,.2f}")
            else:
                print(f"         {d}: ⚠ 无数据")


def check_platform_data(db):
    print("\n")
    print("=" * 70)
    print("  二、联盟平台交易数据完整性")
    print("=" * 70)

    # 获取所有平台
    platforms = db.query(AffiliatePlatform).order_by(AffiliatePlatform.id).all()

    if not platforms:
        print("  (无联盟平台)")
        return

    today = date.today()
    check_begin = date(2026, 1, 1)
    check_end = today - timedelta(days=1)

    for platform in platforms:
        accounts = db.query(AffiliateAccount).filter(
            AffiliateAccount.platform_id == platform.id
        ).all()

        active_count = sum(1 for a in accounts if a.is_active)
        total_count = len(accounts)

        # 查询该平台的交易数据统计
        stats = db.query(
            func.count(AffiliateTransaction.id),
            func.min(AffiliateTransaction.transaction_time),
            func.max(AffiliateTransaction.transaction_time),
            func.sum(AffiliateTransaction.commission_amount)
        ).filter(
            AffiliateTransaction.platform == platform.platform_code
        ).first()

        tx_count = stats[0] or 0
        earliest = stats[1]
        latest = stats[2]
        total_commission = float(stats[3] or 0)

        print(f"\n  [{platform.platform_code}] {platform.platform_name}")
        print(f"       账号: {active_count} 活跃 / {total_count} 总计")
        print(f"       交易记录: {tx_count:,} 条")

        if tx_count == 0:
            print(f"       ⚠ 无交易数据")
            continue

        print(f"       时间范围: {earliest.strftime('%Y-%m-%d') if earliest else 'N/A'} ~ {latest.strftime('%Y-%m-%d') if latest else 'N/A'}")
        print(f"       总佣金: ${total_commission:,.2f}")

        # 按状态统计
        status_stats = db.query(
            AffiliateTransaction.status,
            func.count(AffiliateTransaction.id),
            func.sum(AffiliateTransaction.commission_amount)
        ).filter(
            AffiliateTransaction.platform == platform.platform_code
        ).group_by(AffiliateTransaction.status).all()

        for s_status, s_count, s_comm in status_stats:
            print(f"         {s_status}: {s_count:,} 条, ${float(s_comm or 0):,.2f}")

        # 按月统计最近3个月的数据量
        three_months_ago = today - timedelta(days=90)
        monthly = db.query(
            func.strftime('%Y-%m', AffiliateTransaction.transaction_time).label('month'),
            func.count(AffiliateTransaction.id),
            func.sum(AffiliateTransaction.commission_amount)
        ).filter(
            AffiliateTransaction.platform == platform.platform_code,
            AffiliateTransaction.transaction_time >= three_months_ago
        ).group_by('month').order_by('month').all()

        if monthly:
            print(f"       最近3个月:")
            for m, cnt, comm in monthly:
                print(f"         {m}: {cnt:,} 条, ${float(comm or 0):,.2f}")


def check_overall_summary(db):
    print("\n")
    print("=" * 70)
    print("  三、总览统计")
    print("=" * 70)

    # 用户统计
    user_count = db.query(func.count(User.id)).scalar()
    print(f"  用户数: {user_count}")

    # MCC 统计
    mcc_total = db.query(func.count(GoogleMccAccount.id)).scalar()
    mcc_active = db.query(func.count(GoogleMccAccount.id)).filter(GoogleMccAccount.is_active == True).scalar()
    print(f"  MCC 账号: {mcc_active} 活跃 / {mcc_total} 总计")

    # Google Ads 数据统计
    ads_total = db.query(func.count(GoogleAdsApiData.id)).scalar()
    ads_cost = db.query(func.sum(GoogleAdsApiData.cost)).scalar() or 0
    print(f"  Google Ads 记录: {ads_total:,} 条, 总花费: ${ads_cost:,.2f}")

    # 联盟账号统计
    acc_total = db.query(func.count(AffiliateAccount.id)).scalar()
    acc_active = db.query(func.count(AffiliateAccount.id)).filter(AffiliateAccount.is_active == True).scalar()
    print(f"  联盟账号: {acc_active} 活跃 / {acc_total} 总计")

    # 交易统计
    tx_total = db.query(func.count(AffiliateTransaction.id)).scalar()
    tx_comm = db.query(func.sum(AffiliateTransaction.commission_amount)).scalar() or 0
    print(f"  交易记录: {tx_total:,} 条, 总佣金: ${float(tx_comm):,.2f}")

    # 平台数量
    plat_count = db.query(func.count(AffiliatePlatform.id)).scalar()
    print(f"  联盟平台: {plat_count} 个")

    # 数据库文件大小
    db_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "google_analysis.db")
    if os.path.exists(db_path):
        size_mb = os.path.getsize(db_path) / (1024 * 1024)
        print(f"  数据库大小: {size_mb:.1f} MB")

    print("\n" + "=" * 70)


if __name__ == "__main__":
    db = SessionLocal()
    try:
        check_overall_summary(db)
        check_mcc_data(db)
        check_platform_data(db)
        print("\n  检查完毕。")
        print("=" * 70)
    finally:
        db.close()
