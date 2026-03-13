"""
Google Ads Client 工厂（CR-039）
从 google_ads_service_account_sync.py 中提取，供 keyword_plan / ads_creator 共用。
"""
import json
import logging
from typing import Tuple

from app.config import settings
from app.models.google_ads_api_data import GoogleMccAccount

logger = logging.getLogger(__name__)


def create_google_ads_client(mcc_account: GoogleMccAccount) -> Tuple:
    """创建 Google Ads 客户端，返回 (client, mcc_customer_id)。

    凭证优先级：
    1. MCC 级别 service account（service_account_json）
    2. 全局 service account（env GOOGLE_ADS_SERVICE_ACCOUNT_JSON）
    3. OAuth（client_id / client_secret / refresh_token）
    """
    try:
        from google.ads.googleads.client import GoogleAdsClient
    except ImportError:
        raise ImportError("Google Ads API 库未安装，请执行: pip install google-ads")

    developer_token = settings.google_ads_shared_developer_token or ""
    if not developer_token:
        raise ValueError("缺少开发者令牌（GOOGLE_ADS_SHARED_DEVELOPER_TOKEN）")

    mcc_customer_id = mcc_account.mcc_id.replace("-", "").strip()
    if not mcc_customer_id.isdigit() or len(mcc_customer_id) != 10:
        raise ValueError(f"MCC ID 格式错误: {mcc_account.mcc_id}")

    # 1. MCC 级别 service account
    sa_json = getattr(mcc_account, "service_account_json", None)
    if sa_json:
        creds = _parse_sa_json(sa_json)
        if creds:
            sa_credentials = _create_credentials(creds)
            client = GoogleAdsClient(
                credentials=sa_credentials,
                developer_token=developer_token,
                login_customer_id=mcc_customer_id,
            )
            return client, mcc_customer_id

    # 2. 全局 service account
    global_sa = settings.google_ads_service_account_json or ""
    if global_sa:
        creds = _parse_sa_json(global_sa)
        if creds:
            sa_credentials = _create_credentials(creds)
            client = GoogleAdsClient(
                credentials=sa_credentials,
                developer_token=developer_token,
                login_customer_id=mcc_customer_id,
            )
            return client, mcc_customer_id

    # 3. OAuth
    if mcc_account.client_id and mcc_account.client_secret and mcc_account.refresh_token:
        client = GoogleAdsClient.load_from_dict({
            "developer_token": developer_token,
            "client_id": mcc_account.client_id,
            "client_secret": mcc_account.client_secret,
            "refresh_token": mcc_account.refresh_token,
            "login_customer_id": mcc_customer_id,
        })
        return client, mcc_customer_id

    raise ValueError(f"MCC {mcc_account.mcc_id} 无可用凭证（service account 和 OAuth 均未配置）")


def _parse_sa_json(raw) -> dict:
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw)
    except Exception:
        return {}


def _create_credentials(sa_dict: dict):
    from google.oauth2 import service_account as sa_module
    SCOPES = ["https://www.googleapis.com/auth/adwords"]
    return sa_module.Credentials.from_service_account_info(sa_dict, scopes=SCOPES)
