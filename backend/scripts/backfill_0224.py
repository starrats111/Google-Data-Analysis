"""
手动补同步 8 个 MCC 的 2026-02-24 数据
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datetime import date
from app.database import SessionLocal
from app.models.google_ads_api_data import GoogleMccAccount

TARGET_DATE = date(2026, 2, 24)

MCC_IDS = [
    "941-949-6301",   # zwj0123
    "191-217-0158",   # QMYMCC11291
    "152-782-6127",   # zwjmcc11261
    "658-633-7448",   # MYMCC1209
    "482-938-3854",   # CZSMCC1125
    "218-718-2682",   # wenjun1225
    "821-194-2717",   # QQQMCC11291
    "308-527-6642",   # QQQMCC1208
]


def main():
    from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync

    db = SessionLocal()
    try:
        sync_service = GoogleAdsServiceAccountSync(db)

        print(f"目标日期: {TARGET_DATE}")
        print(f"待补同步: {len(MCC_IDS)} 个 MCC")
        print("=" * 60)

        success_count = 0
        fail_count = 0

        for mcc_id_str in MCC_IDS:
            mcc = db.query(GoogleMccAccount).filter(
                GoogleMccAccount.mcc_id == mcc_id_str
            ).first()

            if not mcc:
                print(f"[跳过] MCC {mcc_id_str} 未找到")
                fail_count += 1
                continue

            print(f"\n[同步] {mcc.mcc_name} ({mcc.mcc_id})...")

            try:
                result = sync_service.sync_mcc_data(
                    mcc.id, TARGET_DATE, force_refresh=True
                )

                if result.get("success"):
                    saved = result.get("saved_count", 0)
                    print(f"  ✓ 成功: {saved} 条记录")
                    success_count += 1
                else:
                    msg = result.get("message", "未知错误")
                    print(f"  ✗ 失败: {msg}")
                    fail_count += 1
            except Exception as e:
                print(f"  ✗ 异常: {e}")
                fail_count += 1

        print("\n" + "=" * 60)
        print(f"完成: 成功 {success_count}, 失败 {fail_count}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
