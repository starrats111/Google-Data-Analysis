"""
D1 清理脚本：删除 CNY 账号的 Google Ads API 历史数据
执行前请备份数据库。兼容 SQLite / PostgreSQL。

用法：
    cd backend
    python -m scripts.clean_cny_google_ads_data
"""
import sys
import os

# N3：确保从任意目录执行均可找到 app 模块
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app.database import SessionLocal
from app.models.google_ads_api_data import GoogleAdsApiData, GoogleMccAccount
import json
from datetime import datetime


def main():
    db = SessionLocal()
    try:
        # 1. 找出 CNY 账号的 mcc_id（E2 修正：完整模型查询，避免 Row 无 .id 属性）
        cny_mccs = db.query(GoogleMccAccount).filter(
            GoogleMccAccount.currency == 'CNY'
        ).all()
        cny_mcc_ids = [m.id for m in cny_mccs]
        
        if not cny_mcc_ids:
            print("无 CNY 账号，无需清理")
            return
        
        print(f"找到 {len(cny_mcc_ids)} 个 CNY 账号，MCC IDs: {cny_mcc_ids}")
        
        # 2. 统计待删除行数（N4 建议：避免加载全部数据到内存）
        count = db.query(GoogleAdsApiData).filter(
            GoogleAdsApiData.mcc_id.in_(cny_mcc_ids)
        ).count()
        
        if count == 0:
            print("无需清理的 CNY 数据")
            return
        
        print(f"共 {count} 行 CNY 数据待删除")
        
        # 3. 备份摘要到 JSON（仅取前 100 行示例）
        sample = db.query(GoogleAdsApiData).filter(
            GoogleAdsApiData.mcc_id.in_(cny_mcc_ids)
        ).limit(100).all()
        
        backup_path = f"cny_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        with open(backup_path, "w", encoding="utf-8") as f:
            json.dump([{
                "id": r.id,
                "mcc_id": r.mcc_id,
                "date": str(r.date),
                "campaign_name": r.campaign_name,
                "cost": r.cost,
                "budget": r.budget,
                "cpc": r.cpc
            } for r in sample], f, indent=2, ensure_ascii=False)
        print(f"备份摘要已写入 {backup_path}（含前 100 行示例）")
        
        # 4. 确认后执行
        confirm = input(f"确认删除 {count} 行 CNY 数据？输入 yes 继续: ")
        if confirm.strip().lower() != "yes":
            print("已取消")
            return
        
        # 5. 执行删除
        deleted = db.query(GoogleAdsApiData).filter(
            GoogleAdsApiData.mcc_id.in_(cny_mcc_ids)
        ).delete(synchronize_session=False)
        db.commit()
        print(f"已删除 {deleted} 行")
        
        # 6. 验证
        remaining = db.query(GoogleAdsApiData).filter(
            GoogleAdsApiData.mcc_id.in_(cny_mcc_ids)
        ).count()
        print(f"验证：CNY 数据剩余 {remaining} 行（应为 0）")
        
        if remaining == 0:
            print("✅ 清理完成，可重新同步 CNY 账号数据")
        else:
            print("⚠️ 仍有残留数据，请检查")
            
    finally:
        db.close()


if __name__ == "__main__":
    main()
