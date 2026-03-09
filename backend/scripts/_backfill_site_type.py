"""
CR-037: 回填已有网站的 site_type
通过 SSH 连接宝塔服务器，自动检测每个网站的架构类型并更新数据库。

用法（在后端服务器上执行）:
  cd ~/Google-Data-Analysis/backend
  python -m scripts._backfill_site_type

或远程执行:
  python backend/scripts/_backfill_site_type.py
"""
import sys
import os

# 支持远程执行
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.database import SessionLocal, engine, Base
from app.models.site import PubSite
from app.services.remote_publisher import remote_publisher

import logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def backfill():
    # 确保新字段存在
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    try:
        sites = db.query(PubSite).all()
        logger.info(f"共 {len(sites)} 个网站需要检测")

        success = 0
        failed = 0
        for site in sites:
            try:
                result = remote_publisher.detect_site_type(site.site_path)
                site_type = result.get("site_type")
                if site_type:
                    site.site_type = site_type
                    site.data_js_path = result.get("data_js_path") or site.data_js_path
                    site.article_var_name = result.get("article_var_name")
                    site.article_html_pattern = result.get("article_html_pattern")
                    db.commit()
                    logger.info(f"  ✓ {site.domain:<25} → {site_type} (data: {result.get('data_js_path')}, var: {result.get('article_var_name')})")
                    success += 1
                else:
                    logger.warning(f"  ✗ {site.domain:<25} → 未识别架构")
                    failed += 1
            except Exception as e:
                logger.error(f"  ✗ {site.domain:<25} → 错误: {e}")
                failed += 1

        logger.info(f"\n回填完成: 成功 {success}, 失败 {failed}, 共 {len(sites)}")
    finally:
        db.close()


if __name__ == "__main__":
    backfill()
