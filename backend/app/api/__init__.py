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










