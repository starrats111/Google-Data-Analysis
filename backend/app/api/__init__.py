"""
API Routers package.

We intentionally re-export the router modules so `app.main` can import and register them.
"""

from . import ad_campaign  # noqa: F401
from . import affiliate  # noqa: F401
from . import analysis  # noqa: F401
from . import auth  # noqa: F401
from . import collabglow  # noqa: F401
from . import linkhaitao  # noqa: F401
from . import dashboard  # noqa: F401
from . import expenses  # noqa: F401
from . import export  # noqa: F401
from . import stage_label  # noqa: F401
from . import upload  # noqa: F401
from . import platform_data  # noqa: F401
from . import google_ads_data  # noqa: F401
from . import mcc  # noqa: F401
from . import feedback  # noqa: F401
from . import merchants  # noqa: F401
from . import notifications  # noqa: F401
from . import users  # noqa: F401
from . import team_management  # noqa: F401
from . import affiliate_transactions  # noqa: F401
from . import bid_management  # noqa: F401
from . import reports  # noqa: F401
from . import system  # noqa: F401
from . import gemini  # noqa: F401
from . import google_ads_aggregate  # noqa: F401
# 露出功能
from . import luchu_articles  # noqa: F401
from . import luchu_ai  # noqa: F401
from . import luchu_reviews  # noqa: F401
from . import luchu_publish  # noqa: F401
from . import luchu_websites  # noqa: F401
from . import luchu_stats  # noqa: F401
from . import luchu_notifications  # noqa: F401
from . import luchu_prompts  # noqa: F401
from . import luchu_logs  # noqa: F401
from . import luchu_images  # noqa: F401

__all__ = [
    "ad_campaign",
    "affiliate",
    "analysis",
    "auth",
    "collabglow",
    "linkhaitao",
    "dashboard",
    "expenses",
    "export",
    "stage_label",
    "upload",
    "platform_data",
    "google_ads_data",
    "mcc",
    "feedback",
    "merchants",
    "notifications",
    "users",
    "team_management",
    "affiliate_transactions",
    "bid_management",
    "reports",
    "system",
    "gemini",
    "google_ads_aggregate",
    "luchu_articles",
    "luchu_ai",
    "luchu_reviews",
    "luchu_publish",
    "luchu_websites",
    "luchu_stats",
    "luchu_notifications",
    "luchu_prompts",
    "luchu_logs",
    "luchu_images",
]










