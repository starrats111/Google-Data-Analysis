"""
手动补同步脚本：为缺数据/过期的 MCC 重新拉取数据

用法：
    cd ~/Google-Data-Analysis/backend
    source venv/bin/activate

    # 补同步所有缺数据的 MCC（过去 7 天）
    python -m scripts.resync_stale_mccs

    # 指定天数
    python -m scripts.resync_stale_mccs --days 14

    # 只同步指定 MCC（用数据库 ID）
    python -m scripts.resync_stale_mccs --mcc-ids 8 10 11 20

    # 只同步 CNY 账号
    python -m scripts.resync_stale_mccs --currency CNY
"""
import sys
import os
import argparse
import time
from datetime import date, timedelta

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))


def main():
    parser = argparse.ArgumentParser(description="手动补同步缺数据的 MCC")
    parser.add_argument("--days", type=int, default=7, help="补同步过去几天的数据（默认 7）")
    parser.add_argument("--mcc-ids", nargs="+", type=int, help="只同步指定的 MCC ID（数据库 ID）")
    parser.add_argument("--currency", type=str, help="只同步指定货币的 MCC（如 CNY）")
    parser.add_argument("--stale-days", type=int, default=3, help="数据过期超过几天才补同步（默认 3）")
    parser.add_argument("--delay", type=float, default=2.0, help="每个 MCC 之间的延迟秒数（默认 2）")
    args = parser.parse_args()

    from app.database import SessionLocal
    from app.models.google_ads_api_data import GoogleMccAccount, GoogleAdsApiData
    from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
    from sqlalchemy import func

    db = SessionLocal()
    sync_service = GoogleAdsServiceAccountSync(db)

    # 获取 MCC 列表
    query = db.query(GoogleMccAccount).filter(GoogleMccAccount.is_active == True)
    if args.mcc_ids:
        query = query.filter(GoogleMccAccount.id.in_(args.mcc_ids))
    if args.currency:
        query = query.filter(GoogleMccAccount.currency == args.currency.upper())
    mccs = query.all()

    if not mccs:
        print("没有找到符合条件的 MCC 账号")
        return

    # 筛选需要补同步的 MCC
    today = date.today()
    yesterday = today - timedelta(days=1)
    targets = []

    for mcc in mccs:
        latest_date_row = db.query(func.max(GoogleAdsApiData.date)).filter(
            GoogleAdsApiData.mcc_id == mcc.id
        ).scalar()

        if latest_date_row is None:
            gap_days = 999
            latest_str = "无数据"
        else:
            gap_days = (today - latest_date_row).days
            latest_str = str(latest_date_row)

        if args.mcc_ids or gap_days >= args.stale_days:
            targets.append((mcc, latest_str, gap_days))

    if not targets:
        print(f"所有 MCC 数据都在 {args.stale_days} 天内，无需补同步")
        return

    print("=" * 70)
    print(f"  MCC 补同步工具")
    print(f"  补同步范围: 过去 {args.days} 天")
    print(f"  目标 MCC: {len(targets)} 个")
    print("=" * 70)

    for mcc, latest_str, gap in targets:
        print(f"  #{mcc.id} {mcc.mcc_id} ({mcc.mcc_name}) [{mcc.currency}] 最新: {latest_str} (缺 {gap} 天)")

    print()
    total_synced = 0
    total_failed = 0

    for idx, (mcc, latest_str, gap) in enumerate(targets):
        print(f"\n{'='*50}")
        print(f"[{idx+1}/{len(targets)}] MCC {mcc.mcc_id} ({mcc.mcc_name}) [{mcc.currency}]")
        print(f"{'='*50}")

        # 计算需要补的日期范围
        sync_days = min(args.days, gap) if gap < 999 else args.days
        dates_to_sync = []
        for d in range(sync_days, 0, -1):
            target_date = today - timedelta(days=d)
            existing = db.query(GoogleAdsApiData).filter(
                GoogleAdsApiData.mcc_id == mcc.id,
                GoogleAdsApiData.date == target_date
            ).count()
            if existing == 0:
                dates_to_sync.append(target_date)

        if not dates_to_sync:
            print(f"  所有日期已有数据，跳过")
            continue

        print(f"  需补同步 {len(dates_to_sync)} 天: {dates_to_sync[0]} ~ {dates_to_sync[-1]}")

        for date_idx, target_date in enumerate(dates_to_sync):
            try:
                print(f"  同步 {target_date} ({date_idx+1}/{len(dates_to_sync)})...", end=" ", flush=True)

                result = sync_service.sync_mcc_data(
                    mcc_id=mcc.id,
                    target_date=target_date,
                    force_refresh=True,
                    only_enabled=False
                )

                if result.get("success"):
                    saved = result.get("saved_count", 0)
                    if result.get("skipped"):
                        print(f"已存在，跳过")
                    elif saved > 0:
                        print(f"✅ 保存 {saved} 条")
                        total_synced += saved
                    else:
                        msg = result.get("message", "")[:80]
                        print(f"⚠️ 0 条 ({msg})")
                else:
                    msg = result.get("message", "未知错误")[:100]
                    print(f"❌ 失败: {msg}")
                    total_failed += 1

                    if result.get("quota_exhausted"):
                        print(f"\n  ⛔ API 配额已耗尽，停止同步")
                        print(f"  已同步: {total_synced} 条 | 失败: {total_failed} 次")
                        db.close()
                        return

                # 请求间延迟
                if date_idx < len(dates_to_sync) - 1:
                    time.sleep(0.5)

            except Exception as e:
                print(f"❌ 异常: {e}")
                total_failed += 1

        # MCC 间延迟
        if idx < len(targets) - 1:
            print(f"  等待 {args.delay}s...")
            time.sleep(args.delay)

    print(f"\n{'='*70}")
    print(f"  补同步完成")
    print(f"  总计保存: {total_synced} 条")
    print(f"  失败次数: {total_failed}")
    print(f"{'='*70}")

    db.close()


if __name__ == "__main__":
    main()
