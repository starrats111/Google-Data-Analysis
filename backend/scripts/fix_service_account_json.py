"""
修复所有MCC的service_account_json字段
- 双重编码 → 正常JSON
- 从全局文件补齐缺失的配置
"""
import sys
import json
from pathlib import Path

# 添加项目路径
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.database import SessionLocal
from app.models.google_ads_api_data import GoogleMccAccount
from app.models.user import User
from app.config import settings


def normalize_json(raw: str) -> str | None:
    """规范化JSON字符串"""
    if not raw or not raw.strip():
        return None
    text = raw.strip()
    if text.startswith('\ufeff'):
        text = text[1:]
    
    # 直接解析
    try:
        result = json.loads(text)
        if isinstance(result, dict) and 'type' in result:
            return json.dumps(result, ensure_ascii=False)
        if isinstance(result, str):
            result2 = json.loads(result)
            if isinstance(result2, dict) and 'type' in result2:
                return json.dumps(result2, ensure_ascii=False)
    except (json.JSONDecodeError, TypeError):
        pass
    
    # 去引号
    if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
        try:
            inner = text[1:-1].replace('\\"', '"').replace("\\'", "'")
            result = json.loads(inner)
            if isinstance(result, dict) and 'type' in result:
                return json.dumps(result, ensure_ascii=False)
        except (json.JSONDecodeError, TypeError):
            pass
    return None


def load_global_sa() -> str | None:
    """从全局文件加载服务账号JSON"""
    if settings.google_ads_service_account_file:
        fp = Path(settings.google_ads_service_account_file)
        if fp.exists():
            with open(fp, 'r', encoding='utf-8') as f:
                return json.dumps(json.load(f), ensure_ascii=False)
    return None


if __name__ == "__main__":
    db = SessionLocal()
    try:
        mccs = db.query(GoogleMccAccount).all()
        print(f"📋 共 {len(mccs)} 个MCC账号\n")
        
        global_sa = load_global_sa()
        if global_sa:
            sa_info = json.loads(global_sa)
            print(f"✅ 全局服务账号文件: {sa_info.get('client_email', '?')}\n")
        else:
            print("⚠️  未找到全局服务账号文件\n")
        
        fixed = 0
        filled = 0
        ok = 0
        
        for mcc in mccs:
            owner = db.query(User).filter(User.id == mcc.user_id).first()
            owner_name = owner.username if owner else "?"
            
            if mcc.service_account_json:
                normalized = normalize_json(mcc.service_account_json)
                if normalized:
                    if normalized != mcc.service_account_json:
                        mcc.service_account_json = normalized
                        mcc.use_service_account = True
                        db.add(mcc)
                        fixed += 1
                        print(f"  🔧 修复 MCC {mcc.mcc_id} ({owner_name}) - JSON已规范化")
                    else:
                        ok += 1
                        print(f"  ✅ 正常 MCC {mcc.mcc_id} ({owner_name})")
                else:
                    # JSON无法解析，用全局配置替换
                    if global_sa:
                        mcc.service_account_json = global_sa
                        mcc.use_service_account = True
                        db.add(mcc)
                        fixed += 1
                        print(f"  🔧 替换 MCC {mcc.mcc_id} ({owner_name}) - 原JSON无法解析，已用全局配置替换")
                    else:
                        print(f"  ❌ 失败 MCC {mcc.mcc_id} ({owner_name}) - JSON无法解析且无全局配置")
            else:
                # 没有JSON，用全局配置填充
                if global_sa:
                    mcc.service_account_json = global_sa
                    mcc.use_service_account = True
                    db.add(mcc)
                    filled += 1
                    print(f"  📥 填充 MCC {mcc.mcc_id} ({owner_name}) - 已从全局配置填充")
                else:
                    print(f"  ❌ 缺失 MCC {mcc.mcc_id} ({owner_name}) - 无JSON且无全局配置")
        
        db.commit()
        print(f"\n🎉 完成: {ok} 个正常, {fixed} 个已修复, {filled} 个已填充")
    except Exception as e:
        db.rollback()
        print(f"❌ 失败: {e}")
    finally:
        db.close()

