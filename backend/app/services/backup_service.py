"""
数据库自动备份服务
SEC-8: 在执行任何清理操作前，保障数据安全网
"""
import os
import sqlite3
import logging
from datetime import datetime, timedelta
from pathlib import Path

from app.config import settings

logger = logging.getLogger(__name__)


def get_db_path() -> str:
    url = settings.DATABASE_URL
    if url.startswith("sqlite:///"):
        path = url.replace("sqlite:///", "")
        if path.startswith("./"):
            base = Path(__file__).resolve().parents[2]
            return str(base / path[2:])
        return path
    return ""


def get_backup_dir() -> Path:
    backup_dir = Path(getattr(settings, "BACKUP_DIR", "")) or (
        Path(__file__).resolve().parents[2] / "backups"
    )
    backup_dir.mkdir(parents=True, exist_ok=True)
    return backup_dir


def backup_database() -> dict:
    db_path = get_db_path()
    if not db_path or not os.path.exists(db_path):
        logger.warning(f"数据库文件不存在或非 SQLite: {db_path}")
        return {"success": False, "message": "数据库文件不存在"}

    backup_dir = get_backup_dir()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    weekday = datetime.now().strftime("%A")
    backup_name = f"google_analysis_{timestamp}.db"
    backup_path = backup_dir / backup_name

    try:
        source = sqlite3.connect(db_path)
        dest = sqlite3.connect(str(backup_path))
        source.backup(dest)
        dest.close()
        source.close()

        size_mb = backup_path.stat().st_size / (1024 * 1024)
        logger.info(f"数据库备份成功: {backup_name} ({size_mb:.1f} MB)")

        cleanup_old_backups(backup_dir)

        return {
            "success": True,
            "path": str(backup_path),
            "size_mb": round(size_mb, 1),
        }
    except Exception as e:
        logger.error(f"数据库备份失败: {e}", exc_info=True)
        return {"success": False, "message": str(e)}


def cleanup_old_backups(backup_dir: Path):
    """保留最近 7 天每日备份 + 每周日备份保留 4 周"""
    backups = sorted(backup_dir.glob("google_analysis_*.db"), reverse=True)
    if len(backups) <= 7:
        return

    now = datetime.now()
    keep = set()

    for f in backups:
        try:
            ts_str = f.stem.replace("google_analysis_", "")
            ts = datetime.strptime(ts_str, "%Y%m%d_%H%M%S")
        except ValueError:
            continue

        age = (now - ts).days

        if age <= 7:
            keep.add(f)
        elif ts.weekday() == 6 and age <= 28:
            keep.add(f)

    for f in backups:
        if f not in keep and f.suffix == ".db" and f.stem.startswith("google_analysis_"):
            try:
                f.unlink()
                logger.info(f"删除过期备份: {f.name}")
            except Exception as e:
                logger.warning(f"无法删除备份 {f.name}: {e}")
