"""
Google Sheets 共享表格同步服务
读取公开/共享的 Google Sheets 数据，导入违规/推荐商家
"""
import re
import csv
import io
import uuid
import logging
from datetime import datetime
from typing import Optional, List, Tuple

import httpx
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.merchant import AffiliateMerchant, MerchantAssignment
from app.models.merchant_violation import MerchantViolation
from app.models.merchant_recommendation import MerchantRecommendation
from app.models.sheet_config import SheetConfig
from app.models.notification import Notification
from app.models.user import User

logger = logging.getLogger(__name__)

PLATFORM_NAME_MAP = {
    "linkhaitao": "LH", "lh": "LH",
    "rewardoo": "RW", "rw": "RW",
    "collabglow": "CG", "cg": "CG",
    "brandsparkhub": "BSH", "bsh": "BSH",
    "partnermatic": "PM", "pm": "PM",
    "creatorflare": "CF", "cf": "CF",
    "linkbux": "LB", "lb": "LB",
}


def extract_sheet_id(url: str) -> Optional[str]:
    """从 Google Sheets URL 提取 spreadsheet ID"""
    m = re.search(r'/spreadsheets/d/([a-zA-Z0-9_-]+)', url)
    return m.group(1) if m else None


def extract_gid(url: str) -> str:
    """从 URL 提取 gid 参数，默认 0"""
    m = re.search(r'[#&?]gid=(\d+)', url)
    return m.group(1) if m else "0"


def fetch_sheet_csv(sheet_url: str) -> List[List[str]]:
    """通过公开 CSV 导出链接读取 Google Sheets 数据"""
    sheet_id = extract_sheet_id(sheet_url)
    if not sheet_id:
        raise ValueError("无法从链接中提取 Google Sheets ID")

    gid = extract_gid(sheet_url)
    csv_url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid={gid}"

    with httpx.Client(timeout=30, follow_redirects=True) as client:
        resp = client.get(csv_url)
        resp.raise_for_status()

    text = resp.text
    reader = csv.reader(io.StringIO(text))
    return [row for row in reader]


def _normalize_platform(raw: str) -> str:
    """标准化平台名"""
    if not raw:
        return ""
    return PLATFORM_NAME_MAP.get(raw.strip().lower(), raw.strip().upper())


def _detect_multi_group_headers(headers: List[str]) -> List[dict]:
    """检测多列并排格式（如：平台|商家名|原因|平台|商家名|原因|...）
    返回每组的列索引列表，如 [{"platform":0,"name":1,"reason":2}, {"platform":3,"name":4,"reason":5}]
    """
    PLATFORM_KEYS = {"平台", "platform"}
    NAME_KEYS = {"商家名", "商家名称", "merchant_name", "广告主名称", "mcid", "advertiser name"}
    REASON_KEYS = {"原因", "违规原因", "reason", "violation_reason", "推荐原因", "recommend_reason"}

    groups = []
    i = 0
    while i < len(headers):
        h = headers[i].strip().lower()
        if h in PLATFORM_KEYS:
            group = {"platform": i}
            # 往后找 name 和 reason
            for j in range(i + 1, min(i + 5, len(headers))):
                hj = headers[j].strip().lower()
                if hj in NAME_KEYS and "name" not in group:
                    group["name"] = j
                elif hj in REASON_KEYS and "reason" not in group:
                    group["reason"] = j
            if "name" in group:
                groups.append(group)
                i = max(group.values()) + 1
                continue
        i += 1
    return groups


def _parse_rows_to_records(rows: List[List[str]], record_type: str = "violation") -> List[dict]:
    """将表格行解析为统一的记录列表，自动适配标准格式和多列并排格式。
    record_type: "violation" 或 "recommendation"
    """
    if len(rows) < 2:
        return []

    headers = [h.strip().lower() for h in rows[0]]

    # 尝试检测多列并排格式
    groups = _detect_multi_group_headers(headers)
    if groups:
        # 多列并排格式
        records = []
        for row in rows[1:]:
            if not row or all(not c.strip() for c in row):
                continue
            for g in groups:
                def _val(key):
                    idx = g.get(key)
                    if idx is not None and idx < len(row) and row[idx].strip():
                        return row[idx].strip()
                    return None
                name = _val("name")
                if not name:
                    continue
                records.append({
                    "mcid": name,  # 多列并排格式中商家名就是 mcid
                    "mid": None,
                    "name": name,
                    "platform": _normalize_platform(_val("platform") or ""),
                    "url": _val("url"),
                    "reason": _val("reason"),
                    "time": _val("time"),
                    "region": _val("region"),
                    "epc": _val("epc"),
                })
        return records

    # 标准格式：逐列匹配
    col = {}
    for i, h in enumerate(headers):
        if h in ("mcid",):
            col["mcid"] = i
        elif h in ("mid", "merchant_mid", "商家id"):
            col["mid"] = i
        elif h in ("merchant_name", "商家名称", "广告主名称", "advertiser name", "商家名"):
            col["name"] = i
        elif h in ("platform", "平台"):
            col["platform"] = i
        elif h in ("merchant_url", "商家url", "网址", "website"):
            col["url"] = i
        elif h in ("violation_time", "违规时间"):
            col["time"] = i
        elif h in ("reason", "violation_reason", "违规原因", "原因", "recommend_reason", "推荐原因"):
            col["reason"] = i
        elif h in ("merchant_region", "商家地区", "merchant base", "地区"):
            col["region"] = i
        elif h.startswith("epc"):
            col["epc"] = i

    if "name" not in col and "mcid" not in col:
        return []

    records = []
    for row in rows[1:]:
        if not row or all(not c.strip() for c in row):
            continue
        def _g(key):
            idx = col.get(key)
            if idx is not None and idx < len(row) and row[idx].strip():
                return row[idx].strip()
            return None
        name = _g("name") or _g("mcid") or ""
        if not name:
            continue
        records.append({
            "mcid": _g("mcid"),
            "mid": _g("mid"),
            "name": name,
            "platform": _normalize_platform(_g("platform") or ""),
            "url": _g("url"),
            "reason": _g("reason"),
            "time": _g("time"),
            "region": _g("region"),
            "epc": _g("epc"),
        })
    return records


def sync_violation_sheet(db: Session, sheet_url: str) -> dict:
    """同步违规商家共享表格"""
    rows = fetch_sheet_csv(sheet_url)
    records = _parse_rows_to_records(rows, "violation")
    if not records:
        return {"total": 0, "new": 0, "skipped": 0, "marked": 0}

    batch_id = f"SHEET-VIO-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:6]}"
    total = len(records)
    new_count = 0
    skipped = 0
    marked = 0

    for rec in records:
        mcid = rec["mcid"]
        mid = rec["mid"]
        name = rec["name"]
        platform = rec["platform"]
        url = rec["url"]
        reason = rec["reason"]

        vtime = None
        if rec["time"]:
            for fmt in ("%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d", "%Y-%m-%d"):
                try:
                    vtime = datetime.strptime(rec["time"], fmt)
                    break
                except ValueError:
                    pass

        # 去重：同 batch 内不重复（同名+同平台）
        exists = db.query(MerchantViolation).filter(
            MerchantViolation.upload_batch == batch_id,
            func.lower(MerchantViolation.merchant_name) == name.lower(),
            MerchantViolation.platform == platform,
        ).first()
        if exists:
            skipped += 1
            continue

        v = MerchantViolation(
            mcid=mcid,
            merchant_mid=mid,
            merchant_name=name,
            platform=platform,
            merchant_url=url,
            violation_reason=reason,
            violation_time=vtime,
            upload_batch=batch_id,
        )
        db.add(v)
        new_count += 1

        # 标记 AffiliateMerchant
        conditions = []
        if mcid:
            conditions.append(
                (func.lower(AffiliateMerchant.mcid) == mcid.lower())
                & (AffiliateMerchant.platform == platform)
            )
        if mid and mid.isdigit():
            conditions.append(
                (AffiliateMerchant.merchant_id == mid)
                & (AffiliateMerchant.platform == platform)
            )
        if name:
            conditions.append(
                (func.lower(AffiliateMerchant.merchant_name) == name.lower())
                & (AffiliateMerchant.platform == platform)
            )
        if conditions:
            matched = db.query(AffiliateMerchant).filter(or_(*conditions)).all()
            for m in matched:
                if m.violation_status != "violated":
                    m.violation_status = "violated"
                    m.violation_time = vtime or datetime.utcnow()
                    marked += 1

    db.commit()

    cfg = db.query(SheetConfig).filter(SheetConfig.config_type == "violation").first()
    if cfg:
        cfg.last_synced_at = datetime.utcnow()
        db.commit()

    return {"total": total, "new": new_count, "skipped": skipped, "marked": marked, "batch_id": batch_id}


def sync_recommendation_sheet(db: Session, sheet_url: str) -> dict:
    """同步推荐商家共享表格"""
    rows = fetch_sheet_csv(sheet_url)
    records = _parse_rows_to_records(rows, "recommendation")
    if not records:
        return {"total": 0, "new": 0, "skipped": 0, "marked": 0}

    batch_id = f"SHEET-REC-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:6]}"
    total = len(records)
    new_count = 0
    skipped = 0
    marked = 0

    for rec in records:
        mcid = rec["mcid"]
        mid = rec["mid"]
        name = rec["name"]
        platform = rec["platform"]
        url = rec["url"]
        region = rec["region"]
        reason = rec["reason"]

        epc_val = None
        if rec.get("epc"):
            try:
                epc_val = float(rec["epc"].replace("$", "").replace(",", ""))
            except ValueError:
                pass

        exists = db.query(MerchantRecommendation).filter(
            MerchantRecommendation.upload_batch == batch_id,
            func.lower(MerchantRecommendation.merchant_name) == name.lower(),
            MerchantRecommendation.platform == platform,
        ).first()
        if exists:
            skipped += 1
            continue

        r = MerchantRecommendation(
            mcid=mcid,
            merchant_mid=mid,
            merchant_name=name,
            platform=platform,
            merchant_url=url,
            recommend_reason=reason,
            merchant_region=region,
            epc=epc_val,
            upload_batch=batch_id,
        )
        db.add(r)
        new_count += 1

        # 标记 AffiliateMerchant
        conditions = []
        if mcid:
            if platform:
                conditions.append(
                    (func.lower(AffiliateMerchant.mcid) == mcid.lower())
                    & (AffiliateMerchant.platform == platform)
                )
            else:
                conditions.append(func.lower(AffiliateMerchant.mcid) == mcid.lower())
        if mid and mid.isdigit():
            conditions.append(AffiliateMerchant.merchant_id == mid)
        if name:
            conditions.append(func.lower(AffiliateMerchant.merchant_name) == name.lower())
        if conditions:
            matched = db.query(AffiliateMerchant).filter(or_(*conditions)).all()
            for m in matched:
                if m.recommendation_status != "recommended":
                    m.recommendation_status = "recommended"
                    m.recommendation_time = datetime.utcnow()
                    marked += 1

    db.commit()

    cfg = db.query(SheetConfig).filter(SheetConfig.config_type == "recommendation").first()
    if cfg:
        cfg.last_synced_at = datetime.utcnow()
        db.commit()

    return {"total": total, "new": new_count, "skipped": skipped, "marked": marked, "batch_id": batch_id}


def write_violation_to_sheet(sheet_url: str, merchant_name: str, mcid: str, platform: str,
                              reason: str, reporter: str) -> bool:
    """审核通过后，将违规记录追加写入 Google Sheets（通过 Google Forms 或 Apps Script）
    注意：直接写入公开 Sheets 需要 API key 或 service account。
    这里使用 Google Sheets API v4 的 append 方法。
    如果没有 API 凭证，返回 False 并记录日志。
    """
    # TODO: 如果需要写入 Google Sheets，需要配置 Google API 凭证
    # 目前先记录到数据库，后续可以通过 Google Sheets API 写入
    logger.info("[SheetSync] 违规记录待写入 Sheets: %s (%s) - %s by %s",
                merchant_name, mcid, reason, reporter)
    return False
