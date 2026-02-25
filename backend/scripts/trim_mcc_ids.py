"""
修复数据库中 MCC ID / MCC Name 字段的前后空格问题
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal
from app.models.google_ads_api_data import GoogleMccAccount


def main():
    db = SessionLocal()
    try:
        mccs = db.query(GoogleMccAccount).all()
        fixed = 0

        for mcc in mccs:
            changed = False
            trimmed_id = mcc.mcc_id.strip() if mcc.mcc_id else mcc.mcc_id
            trimmed_name = mcc.mcc_name.strip() if mcc.mcc_name else mcc.mcc_name

            if trimmed_id != mcc.mcc_id:
                print(f"[修复] MCC ID: \"{mcc.mcc_id}\" -> \"{trimmed_id}\"  (name: {mcc.mcc_name})")
                mcc.mcc_id = trimmed_id
                changed = True

            if trimmed_name != mcc.mcc_name:
                print(f"[修复] MCC Name: \"{mcc.mcc_name}\" -> \"{trimmed_name}\"  (id: {mcc.mcc_id})")
                mcc.mcc_name = trimmed_name
                changed = True

            if changed:
                fixed += 1

        if fixed > 0:
            db.commit()
            print(f"\n共修复 {fixed} 条记录")
        else:
            print("所有 MCC ID / Name 均无多余空格，无需修复")
    finally:
        db.close()


if __name__ == "__main__":
    main()
