"""
SemRush 关键词研究服务
通过 SemRush 代理获取域名的自然搜索关键词和竞争对手广告素材。
替代 Google Ads KeywordPlanIdeaService（后者需要开发者令牌"基本"权限）。
"""
import json as _json
import logging
import re
import time
import uuid
from typing import List, Dict, Optional, Tuple
from urllib.parse import urlparse, parse_qs, unquote

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

logger = logging.getLogger(__name__)

COUNTRY_MAP = {
    "US": "us", "UK": "uk", "CA": "ca", "AU": "au",
    "DE": "de", "FR": "fr", "JP": "jp", "BR": "br",
}


class SemRushService:
    """SemRush 代理服务，用于关键词研究和竞品广告分析"""

    def __init__(self, username: str = "yongpei", password: str = "lan181615"):
        self.username = username
        self.password = password
        self.session = requests.Session()
        self.session.verify = False
        self.session.headers.update({
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        })
        self.token = None
        self.apikey = None
        self.user_id = 444444444
        self.node = "10"
        self.uuid = str(uuid.uuid4())

    def login(self) -> bool:
        try:
            resp = self.session.get(
                f"https://dash.3ue.co/api/account/login"
                f"?username={self.username}&password={self.password}&ts={int(time.time() * 1000)}",
                timeout=15,
            )
            data = resp.json()
            self.token = data.get("data", {}).get("token")
            if self.token:
                logger.info("[SemRush] 登录成功")
                return True
            logger.error("[SemRush] 登录失败: 无 token")
            return False
        except Exception as e:
            logger.error(f"[SemRush] 登录异常: {e}")
            return False

    def _get_apikey(self) -> bool:
        cookies = {"GMITM_config": '{"semrush":{"node": ' + self.node + ',"lang":"zh"}}'}
        try:
            resp = self.session.get(
                "https://sem.3ue.co/home/?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU",
                cookies=cookies, timeout=15,
            )
            match = re.search(r'window\.sm2\.user\s*=\s*(\{.*?\});', resp.text)
            if match:
                user_obj = _json.loads(match.group(1))
                self.apikey = user_obj.get("api_key", "")
                self.user_id = user_obj.get("id", 444444444)
                if self.apikey:
                    logger.info(f"[SemRush] 获取 API key 成功 (userId={self.user_id})")
                    return True
            logger.error("[SemRush] 获取 API key 失败: 未在 window.sm2.user 中找到 api_key")
            return False
        except Exception as e:
            logger.error(f"[SemRush] 获取 API key 异常: {e}")
            return False

    def _ensure_ready(self) -> bool:
        if not self.token:
            if not self.login():
                return False
        if not self.apikey:
            if not self._get_apikey():
                return False
        return True

    @staticmethod
    def parse_semrush_url(semrush_url: str) -> Optional[Dict]:
        """从 SemRush URL 中解析出查询参数（域名、searchType、database）"""
        try:
            parsed = urlparse(semrush_url)
            if "3ue.co" not in parsed.hostname and "semrush.com" not in parsed.hostname:
                return None
            qs = parse_qs(parsed.query)
            q = qs.get("q", [""])[0]
            if not q:
                return None
            domain = q.replace("https://", "").replace("http://", "").rstrip("/")
            return {
                "domain": domain,
                "search_type": qs.get("searchType", ["subdomain"])[0],
                "database": qs.get("db", ["us"])[0],
            }
        except Exception:
            return None

    def get_organic_keywords(
        self, url: str, country: str = "us", search_type: str = "auto",
    ) -> List[Dict]:
        """获取域名的自然搜索关键词。
        search_type: "domain", "subdomain", 或 "auto"（依次尝试 subdomain → domain）。
        """
        if not self._ensure_ready():
            raise ValueError("SemRush 服务初始化失败")

        country_code = COUNTRY_MAP.get(country.upper(), country.lower())
        cookies = {"GMITM_config": '{"semrush":{"node": ' + self.node + ',"lang":"zh"}}'}
        domain = url.replace("https://", "").replace("http://", "").rstrip("/")
        headers = {"content-type": "application/json"}

        search_types = (
            [search_type] if search_type in ("domain", "subdomain")
            else ["subdomain", "domain"]
        )

        for st in search_types:
            data = {
                "id": 12,
                "jsonrpc": "2.0",
                "method": "organic.PositionsOverview",
                "params": {
                    "request_id": str(uuid.uuid4()),
                    "report": "domain.overview",
                    "args": {
                        "database": country_code,
                        "dateType": "daily",
                        "dateFormat": "date",
                        "searchItem": domain,
                        "searchType": st,
                        "positionsType": "all",
                    },
                    "userId": self.user_id,
                    "apiKey": self.apikey,
                },
            }
            try:
                resp = self.session.post(
                    "https://sem.3ue.co/dpa/rpc?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU",
                    json=data, cookies=cookies, headers=headers, timeout=30,
                )
                resp_data = resp.json()
                if resp_data.get("error"):
                    logger.warning(f"[SemRush] {st} 查询出错: {resp_data['error']}")
                    continue
                raw_results = resp_data.get("result", [])
                if not raw_results:
                    logger.info(f"[SemRush] {st} 无结果，尝试下一种 searchType")
                    continue

                results = []
                for r in raw_results:
                    results.append({
                        "keyword": r.get("phrase", ""),
                        "avg_monthly_searches": r.get("volume", 0) or 0,
                        "competition": self._map_competition(r.get("competition", 0)),
                        "competition_index": int((r.get("competition", 0) or 0) * 100),
                        "low_top_of_page_bid": r.get("cpc", 0) or 0,
                        "high_top_of_page_bid": (r.get("cpc", 0) or 0) * 1.5,
                        "position": r.get("position", 0),
                    })
                results.sort(key=lambda x: x["avg_monthly_searches"], reverse=True)
                logger.info(f"[SemRush] 返回 {len(results)} 个关键词 (domain={domain}, type={st}, db={country_code})")
                return results
            except Exception as e:
                logger.error(f"[SemRush] organic ({st}) 查询失败: {e}")
                continue

        logger.warning(f"[SemRush] 所有 searchType 均无结果 (domain={domain})")
        return []

    def get_ad_copies(self, url: str, country: str = "us") -> Tuple[List[str], List[str]]:
        """获取竞争对手的广告标题和描述"""
        if not self._ensure_ready():
            raise ValueError("SemRush 服务初始化失败")

        country_code = COUNTRY_MAP.get(country.upper(), country.lower())
        domain = url.replace("https://", "").replace("http://", "").rstrip("/")
        cookies = {"GMITM_config": '{"semrush":{"node":' + self.node + ',"lang":"zh"}}'}
        headers = {"content-type": "application/json"}

        try:
            t = int(time.time())
            data = [
                {"id": 3, "jsonrpc": "2.0", "method": "user.Databases",
                 "params": {"userId": self.user_id, "apiKey": self.apikey}},
                {"id": 2, "jsonrpc": "2.0", "method": "adwords.SnapshotDates",
                 "params": {"database": country_code, "userId": self.user_id, "apiKey": self.apikey}},
            ]
            resp = self.session.post(
                "https://sem.3ue.co/dpa/rpc?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU",
                json=data, cookies=cookies, headers=headers, timeout=15,
            )
            daily = resp.json()[1]["result"]["daily"][0]

            data = {
                "id": 4, "jsonrpc": "2.0", "method": "token.Get",
                "params": {
                    "reportType": "adwords.copies", "database": country_code,
                    "date": t, "dateType": "daily", "searchItem": domain,
                    "page": 1, "pageSize": 100,
                    "userId": self.user_id, "apiKey": self.apikey,
                },
            }
            resp = self.session.post(
                "https://sem.3ue.co/dpa/rpc?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU",
                json=data, cookies=cookies, headers=headers, timeout=15,
            )
            token = resp.json()["result"]["token"]

            data = [{
                "id": 5, "jsonrpc": "2.0", "method": "adwords.Copies",
                "params": {
                    "token": token, "database": country_code,
                    "searchItem": domain, "searchType": "domain",
                    "date": daily, "dateType": "daily", "filter": {},
                    "display": {"order": {"field": "copy_positions", "direction": "desc"},
                                "page": 1, "pageSize": 100},
                    "userId": self.user_id,
                },
            }]
            resp = self.session.post(
                "https://sem.3ue.co/dpa/rpc?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU",
                json=data, cookies=cookies, headers=headers, timeout=15,
            )
            resp_data = resp.json()
            titles, descriptions = [], []
            for r in resp_data[0].get("result", []):
                if r.get("title"):
                    titles.append(r["title"])
                if r.get("description"):
                    descriptions.append(r["description"])
            logger.info(f"[SemRush] 获取 {len(titles)} 个广告标题, {len(descriptions)} 个描述")
            return titles, descriptions
        except Exception as e:
            logger.error(f"[SemRush] adwords 查询失败: {e}")
            return [], []

    @staticmethod
    def _map_competition(val) -> str:
        if not val:
            return "LOW"
        if val > 0.66:
            return "HIGH"
        if val > 0.33:
            return "MEDIUM"
        return "LOW"
