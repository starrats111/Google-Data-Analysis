"""
Google Sheets 同步服务（OPT-005 脚本模式）
从 MCC 脚本导出的 Google Sheet 读取广告数据并写入 google_ads_api_data 表
"""
import base64
import json
import logging
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.config import settings
from app.models.google_ads_api_data import GoogleAdsApiData, GoogleMccAccount
from app.services.campaign_matcher import CampaignMatcher

logger = logging.getLogger(__name__)

SHEET_READ_INTERVAL = 2  # 每个 MCC 读取间隔（秒）
SHEET_MAX_RETRIES = 3
SHEET_NAME = "DailyData"


def _get_sheets_credentials():
    """加载 Sheets 用服务账号（独立于 Google Ads）"""
    creds = None
    # 优先 Base64
    if getattr(settings, "google_sheets_service_account_json_base64", ""):
        try:
            raw = base64.b64decode(settings.google_sheets_service_account_json_base64).decode("utf-8")
            info = json.loads(raw)
            from google.oauth2 import service_account
            creds = service_account.Credentials.from_service_account_info(
                info,
                scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"],
            )
            return creds
        except Exception as e:
            logger.error("Sheets 服务账号 Base64 解析失败: %s", e)
    # 文件
    path = getattr(settings, "google_sheets_service_account_file", "") or ""
    if path:
        p = Path(path)
        if not p.is_absolute():
            p = Path(__file__).resolve().parents[2] / p
        if p.exists():
            try:
                from google.oauth2 import service_account
                creds = service_account.Credentials.from_service_account_file(
                    str(p),
                    scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"],
                )
                return creds
            except Exception as e:
                logger.error("Sheets 服务账号文件加载失败: %s", e)
    return None


def _extract_sheet_id_from_url(url: str) -> Optional[str]:
    """从 Google Sheet URL 提取 spreadsheetId"""
    if not url:
        return None
    # https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit...
    if "/d/" in url:
        part = url.split("/d/")[1]
        return part.split("/")[0].strip()
    return None


def _read_sheet_with_retry(spreadsheet_id: str, range_name: str) -> List[List[Any]]:
    """读取 Sheet 指定范围，429 时指数退避重试"""
    creds = _get_sheets_credentials()
    if not creds:
        raise RuntimeError("未配置 Google Sheets 服务账号")
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
    service = build("sheets", "v4", credentials=creds, cache_discovery=False)
    sheet = service.spreadsheets()
    for attempt in range(SHEET_MAX_RETRIES):
        try:
            result = sheet.values().get(spreadsheetId=spreadsheet_id, range=range_name).execute()
            return result.get("values", [])
        except HttpError as e:
            if e.resp.status == 429 and attempt < SHEET_MAX_RETRIES - 1:
                wait = 5 * (2 ** attempt)
                logger.warning("Sheets API 限流，%ds 后重试", wait)
                time.sleep(wait)
            else:
                raise
    return []


class GoogleSheetSyncService:
    """从 Google Sheets 同步 MCC 广告数据到 google_ads_api_data"""

    def __init__(self, db: Session):
        self.db = db
        self.matcher = CampaignMatcher(db)

    def _is_first_sheet_sync(self, mcc: GoogleMccAccount) -> bool:
        return mcc.last_sheet_sync_at is None

    def sync_mcc_from_sheet(
        self, mcc: GoogleMccAccount, force_refresh: bool = False, force_full_sync: bool = False
    ) -> Dict[str, Any]:
        """
        从 Google Sheet 读取数据并 UPSERT 到 google_ads_api_data。
        首次同步：本月1号~昨天；日常同步：昨天 1 天。
        完成后更新 mcc.last_sheet_sync_at。
        """
        sheet_url = (mcc.google_sheet_url or "").strip()
        if not sheet_url:
            return {"success": False, "message": "未配置 Google Sheet URL"}
        sid = _extract_sheet_id_from_url(sheet_url)
        if not sid:
            return {"success": False, "message": "无效的 Sheet URL"}
        try:
            values = _read_sheet_with_retry(sid, f"{SHEET_NAME}!A:K")
        except Exception as e:
            logger.exception("读取 Sheet 失败: %s", e)
            return {"success": False, "message": str(e)}
        if not values:
            self._update_last_sheet_sync_at(mcc)
            return {"success": True, "inserted": 0, "updated": 0, "skipped": 0}
        # 首行为表头
        headers = [str(h).strip() for h in values[0]]
        col = {h: i for i, h in enumerate(headers)}
        for key in ("Date", "CampaignId", "CampaignName", "Cost", "Impressions", "Clicks"):
            if key not in col:
                return {"success": False, "message": f"Sheet 缺少列: {key}"}
        # 日期范围
        is_first = self._is_first_sheet_sync(mcc) or force_full_sync
        today = date.today()
        yesterday = today - timedelta(days=1)
        if is_first:
            start = today.replace(day=1)
            end = yesterday
        else:
            start = end = yesterday
        inserted, updated = 0, 0
        mcc_id_pk = mcc.id
        user_id = mcc.user_id
        now_utc = datetime.utcnow()
        for row in values[1:]:
            if len(row) <= max(col.get("Date", 0), col.get("CampaignId", 0), col.get("CampaignName", 0)):
                continue
            try:
                date_str = row[col["Date"]].strip() if col["Date"] < len(row) else ""
                campaign_id = row[col["CampaignId"]] if col["CampaignId"] < len(row) else ""
                campaign_name = (row[col["CampaignName"]] or "").strip() if col["CampaignName"] < len(row) else ""
                if not date_str or not campaign_id or not campaign_name:
                    continue
                row_date = datetime.strptime(date_str[:10], "%Y-%m-%d").date()
                if row_date < start or row_date > end:
                    continue
                campaign_id_str = str(campaign_id).strip()
                cost_micros = 0
                if "Cost" in col and col["Cost"] < len(row) and row[col["Cost"]] not in (None, ""):
                    try:
                        cost_micros = int(float(row[col["Cost"]]))
                    except (ValueError, TypeError):
                        pass
                cost = cost_micros / 1_000_000.0
                impressions = float(row[col["Impressions"]]) if col["Impressions"] < len(row) and row[col["Impressions"]] not in (None, "") else 0.0
                clicks = float(row[col["Clicks"]]) if col["Clicks"] < len(row) and row[col["Clicks"]] not in (None, "") else 0.0
                platform_info = self.matcher.extract_platform_from_campaign_name(campaign_name, user_id)
                existing = self.db.query(GoogleAdsApiData).filter(
                    GoogleAdsApiData.mcc_id == mcc_id_pk,
                    GoogleAdsApiData.campaign_id == campaign_id_str,
                    GoogleAdsApiData.date == row_date,
                ).first()
                if existing:
                    existing.cost = cost
                    existing.impressions = impressions
                    existing.clicks = clicks
                    existing.campaign_name = campaign_name
                    existing.extracted_platform_code = (platform_info or {}).get("platform_code")
                    existing.extracted_account_code = (platform_info or {}).get("account_code")
                    existing.last_sync_at = now_utc
                    updated += 1
                else:
                    self.db.add(
                        GoogleAdsApiData(
                            mcc_id=mcc_id_pk,
                            user_id=user_id,
                            customer_id=row[col["Account"]] if col.get("Account") is not None and col["Account"] < len(row) else None,
                            campaign_id=campaign_id_str,
                            campaign_name=campaign_name,
                            date=row_date,
                            cost=cost,
                            impressions=impressions,
                            clicks=clicks,
                            cpc=clicks and cost / clicks or 0.0,
                            extracted_platform_code=(platform_info or {}).get("platform_code"),
                            extracted_account_code=(platform_info or {}).get("account_code"),
                        )
                    )
                    inserted += 1
            except Exception as e:
                logger.warning("解析行失败: %s", e)
                continue
        self.db.commit()
        self._update_last_sheet_sync_at(mcc)
        logger.info(
            "MCC %s Sheet 同步完成: %s ~ %s, 插入 %s, 更新 %s",
            mcc.mcc_name, start, end, inserted, updated,
        )
        return {"success": True, "inserted": inserted, "updated": updated, "skipped": 0}

    def _update_last_sheet_sync_at(self, mcc: GoogleMccAccount) -> None:
        mcc.last_sheet_sync_at = datetime.utcnow()
        self.db.add(mcc)
        self.db.commit()

    def test_sheet_connection(self, sheet_url: str) -> Dict[str, Any]:
        """测试 Sheet 连接，返回行数、最新日期、列名"""
        sid = _extract_sheet_id_from_url(sheet_url)
        if not sid:
            return {"status": "error", "message": "无效的 Sheet URL"}
        try:
            values = _read_sheet_with_retry(sid, f"{SHEET_NAME}!A:K")
        except Exception as e:
            return {"status": "error", "message": str(e)}
        if not values:
            return {"status": "ok", "row_count": 0, "last_date": None, "sample_columns": []}
        headers = values[0]
        row_count = len(values) - 1
        last_date = None
        date_col = None
        for i, h in enumerate(headers):
            if str(h).strip() == "Date":
                date_col = i
                break
        if date_col is not None and len(values) > 1:
            dates = []
            for row in values[1:]:
                if date_col < len(row) and row[date_col]:
                    try:
                        d = datetime.strptime(str(row[date_col])[:10], "%Y-%m-%d").date()
                        dates.append(d)
                    except ValueError:
                        pass
            if dates:
                last_date = max(dates).isoformat()
        return {
            "status": "ok",
            "row_count": row_count,
            "last_date": last_date,
            "sample_columns": [str(h).strip() for h in headers],
        }
