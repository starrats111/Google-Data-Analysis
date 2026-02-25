"""
全系统一键测试脚本
测试所有 API 端点的可用性和响应正确性

用法:
  cd backend && source venv/bin/activate
  python -m scripts.full_system_test --base-url https://api.google-data-analysis.top \
    --username wj07 --password "wj123456" \
    --manager-username manager --manager-password "m123456" \
    --leader-username wjzu --leader-password "wj123456"

角色体系:
  manager  - 经理 (1个): 用户名 manager
  leader   - 组长 (3个): wjzu / jyzu / yzzu
  member   - 组员 (30个): wj01-wj10 / jy01-jy10 / yz01-yz10
"""
import sys
import os
import argparse
import time
import json
from datetime import date, timedelta
from dataclasses import dataclass, field
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    import requests
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "requests"])
    import requests


@dataclass
class TestResult:
    module: str
    name: str
    method: str
    path: str
    status: str  # PASS / FAIL / SKIP / WARN
    status_code: int = 0
    detail: str = ""
    response_time_ms: int = 0


@dataclass
class TestSuite:
    base_url: str
    token: str = ""
    manager_token: str = ""
    leader_token: str = ""
    results: list = field(default_factory=list)
    username: str = ""
    password: str = ""
    manager_username: str = ""
    manager_password: str = ""
    leader_username: str = ""
    leader_password: str = ""

    def _headers(self, token: str = None):
        t = token or self.token
        h = {"Content-Type": "application/json"}
        if t:
            h["Authorization"] = f"Bearer {t}"
        return h

    def _request(self, method, path, token=None, no_auth=False, form_data=None, **kwargs):
        url = f"{self.base_url}{path}"
        if no_auth:
            headers = {}
        else:
            headers = self._headers(token)
        if form_data:
            headers.pop("Content-Type", None)
            kwargs["data"] = form_data
        kwargs.setdefault("timeout", 30)
        kwargs.setdefault("headers", headers)
        start = time.time()
        resp = getattr(requests, method.lower())(url, **kwargs)
        elapsed = int((time.time() - start) * 1000)
        return resp, elapsed

    def add(self, module, name, method, path, resp, elapsed, expect_codes=None):
        expect_codes = expect_codes or [200]
        status = "PASS" if resp.status_code in expect_codes else "FAIL"
        detail = ""
        if status == "FAIL":
            try:
                detail = resp.text[:300]
            except Exception:
                detail = f"HTTP {resp.status_code}"
        self.results.append(TestResult(
            module=module, name=name, method=method, path=path,
            status=status, status_code=resp.status_code,
            detail=detail, response_time_ms=elapsed
        ))
        return status == "PASS"

    def skip(self, module, name, method, path, reason):
        self.results.append(TestResult(
            module=module, name=name, method=method, path=path,
            status="SKIP", detail=reason
        ))

    def warn(self, module, name, method, path, reason):
        self.results.append(TestResult(
            module=module, name=name, method=method, path=path,
            status="WARN", detail=reason
        ))

    # ===== 0. 基础连通性 =====
    def test_health(self):
        m = "基础连通"
        try:
            resp, elapsed = self._request("GET", "/health", no_auth=True)
            self.add(m, "健康检查 /health", "GET", "/health", resp, elapsed)
        except Exception as e:
            self.results.append(TestResult(m, "健康检查 /health", "GET", "/health", "FAIL", detail=str(e)))
        try:
            resp2, elapsed2 = self._request("GET", "/", no_auth=True)
            self.add(m, "根路径 /", "GET", "/", resp2, elapsed2)
        except Exception as e:
            self.results.append(TestResult(m, "根路径 /", "GET", "/", "FAIL", detail=str(e)))
        try:
            resp3, elapsed3 = self._request("GET", "/api/system/health", no_auth=True)
            self.add(m, "系统健康 /api/system/health", "GET", "/api/system/health", resp3, elapsed3)
        except Exception as e:
            self.results.append(TestResult(m, "系统健康", "GET", "/api/system/health", "FAIL", detail=str(e)))

    # ===== 1. 认证模块（三种角色） =====
    def test_auth(self):
        m = "认证模块"

        # 组员登录
        try:
            resp, elapsed = self._request("POST", "/api/auth/login", no_auth=True,
                                          form_data={"username": self.username, "password": self.password})
            ok = self.add(m, f"组员登录 ({self.username})", "POST", "/api/auth/login", resp, elapsed)
            if ok:
                self.token = resp.json().get("access_token", "")
        except Exception as e:
            self.results.append(TestResult(m, "组员登录", "POST", "/api/auth/login", "FAIL", detail=str(e)))

        # 经理登录
        if self.manager_username and self.manager_password:
            try:
                resp, elapsed = self._request("POST", "/api/auth/login", no_auth=True,
                                              form_data={"username": self.manager_username, "password": self.manager_password})
                ok = self.add(m, f"经理登录 ({self.manager_username})", "POST", "/api/auth/login", resp, elapsed)
                if ok:
                    self.manager_token = resp.json().get("access_token", "")
            except Exception as e:
                self.results.append(TestResult(m, "经理登录", "POST", "/api/auth/login", "FAIL", detail=str(e)))
        else:
            self.skip(m, "经理登录", "POST", "/api/auth/login", "未提供经理账号")

        # 组长登录
        if self.leader_username and self.leader_password:
            try:
                resp, elapsed = self._request("POST", "/api/auth/login", no_auth=True,
                                              form_data={"username": self.leader_username, "password": self.leader_password})
                ok = self.add(m, f"组长登录 ({self.leader_username})", "POST", "/api/auth/login", resp, elapsed)
                if ok:
                    self.leader_token = resp.json().get("access_token", "")
            except Exception as e:
                self.results.append(TestResult(m, "组长登录", "POST", "/api/auth/login", "FAIL", detail=str(e)))
        else:
            self.skip(m, "组长登录", "POST", "/api/auth/login", "未提供组长账号")

        # 获取当前用户
        if not self.token:
            self.skip(m, "获取当前用户", "GET", "/api/auth/me", "无有效token")
            return
        try:
            resp, elapsed = self._request("GET", "/api/auth/me")
            self.add(m, "获取当前用户 /me", "GET", "/api/auth/me", resp, elapsed)
        except Exception as e:
            self.results.append(TestResult(m, "获取当前用户", "GET", "/api/auth/me", "FAIL", detail=str(e)))

        # 用户统计
        try:
            resp, elapsed = self._request("GET", "/api/user/statistics")
            self.add(m, "用户统计", "GET", "/api/user/statistics", resp, elapsed)
        except Exception as e:
            self.results.append(TestResult(m, "用户统计", "GET", "/api/user/statistics", "FAIL", detail=str(e)))

    # ===== 2. MCC 账号管理 =====
    def test_mcc(self):
        m = "MCC管理"
        if not self.token:
            self.skip(m, "全部", "GET", "/api/mcc/accounts", "未登录")
            return
        endpoints = [
            ("列出MCC账号", "GET", "/api/mcc/accounts"),
            ("服务账号状态", "GET", "/api/mcc/service-account/status"),
            ("同步状态", "GET", "/api/mcc/sync-status"),
        ]
        for name, method, path in endpoints:
            try:
                resp, elapsed = self._request(method, path)
                self.add(m, name, method, path, resp, elapsed)
            except Exception as e:
                self.results.append(TestResult(m, name, method, path, "FAIL", detail=str(e)))

        # 经理查看用户MCC
        if self.manager_token:
            try:
                resp, elapsed = self._request("GET", "/api/mcc/by-user/1", token=self.manager_token)
                self.add(m, "查看用户MCC(经理)", "GET", "/api/mcc/by-user/1", resp, elapsed, expect_codes=[200, 404])
            except Exception as e:
                self.results.append(TestResult(m, "查看用户MCC", "GET", "/api/mcc/by-user/1", "FAIL", detail=str(e)))

    # ===== 3. 联盟平台管理 =====
    def test_affiliate(self):
        m = "联盟平台"
        if not self.token:
            self.skip(m, "全部", "GET", "/api/affiliate/platforms", "未登录")
            return
        endpoints = [
            ("列出平台", "GET", "/api/affiliate/platforms"),
            ("列出账号", "GET", "/api/affiliate/accounts"),
        ]
        for name, method, path in endpoints:
            try:
                resp, elapsed = self._request(method, path)
                self.add(m, name, method, path, resp, elapsed)
            except Exception as e:
                self.results.append(TestResult(m, name, method, path, "FAIL", detail=str(e)))

        if self.manager_token:
            try:
                resp, elapsed = self._request("GET", "/api/affiliate/accounts/by-employees", token=self.manager_token)
                self.add(m, "按员工分组(经理)", "GET", "/api/affiliate/accounts/by-employees", resp, elapsed)
            except Exception as e:
                self.results.append(TestResult(m, "按员工分组", "GET", "/api/affiliate/accounts/by-employees", "FAIL", detail=str(e)))

    # ===== 4. Google Ads 数据 =====
    def test_google_ads_data(self):
        m = "Google Ads数据"
        if not self.token:
            self.skip(m, "全部", "GET", "/api/google-ads-data/", "未登录")
            return
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        week_ago = (date.today() - timedelta(days=7)).isoformat()
        endpoints = [
            ("原始数据", "GET", f"/api/google-ads-data/?start_date={week_ago}&end_date={yesterday}"),
            ("数据汇总", "GET", f"/api/google-ads-data/summary?start_date={week_ago}&end_date={yesterday}"),
            ("按系列聚合", "GET", f"/api/google-ads-aggregate/by-campaign?start_date={week_ago}&end_date={yesterday}"),
            ("单行汇总", "GET", f"/api/google-ads-aggregate?start_date={week_ago}&end_date={yesterday}"),
        ]
        for name, method, path in endpoints:
            try:
                resp, elapsed = self._request(method, path)
                self.add(m, name, method, path, resp, elapsed)
            except Exception as e:
                self.results.append(TestResult(m, name, method, path, "FAIL", detail=str(e)))

    # ===== 5. 平台数据 =====
    def test_platform_data(self):
        m = "平台数据"
        if not self.token:
            self.skip(m, "全部", "GET", "/api/platform-data/summary", "未登录")
            return
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        week_ago = (date.today() - timedelta(days=7)).isoformat()
        endpoints = [
            ("数据汇总", "GET", f"/api/platform-data/summary?start_date={week_ago}&end_date={yesterday}"),
            ("数据明细", "GET", f"/api/platform-data/detail?start_date={week_ago}&end_date={yesterday}"),
            ("交易记录", "GET", f"/api/platform-data/transactions?start_date={week_ago}&end_date={yesterday}&page=1&page_size=10"),
        ]
        for name, method, path in endpoints:
            try:
                resp, elapsed = self._request(method, path)
                self.add(m, name, method, path, resp, elapsed)
            except Exception as e:
                self.results.append(TestResult(m, name, method, path, "FAIL", detail=str(e)))

    # ===== 6. 联盟交易 =====
    def test_affiliate_transactions(self):
        m = "联盟交易"
        if not self.token:
            self.skip(m, "全部", "GET", "/api/affiliate-transactions/summary", "未登录")
            return
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        week_ago = (date.today() - timedelta(days=7)).isoformat()
        endpoints = [
            ("交易汇总", "GET", f"/api/affiliate-transactions/summary?start_date={week_ago}&end_date={yesterday}"),
            ("拒付详情", "GET", f"/api/affiliate-transactions/rejections?start_date={week_ago}&end_date={yesterday}"),
        ]
        for name, method, path in endpoints:
            try:
                resp, elapsed = self._request(method, path)
                self.add(m, name, method, path, resp, elapsed)
            except Exception as e:
                self.results.append(TestResult(m, name, method, path, "FAIL", detail=str(e)))

    # ===== 7. 分析模块 =====
    def test_analysis(self):
        m = "数据分析"
        if not self.token:
            self.skip(m, "全部", "GET", "/api/analysis/results", "未登录")
            return
        try:
            resp, elapsed = self._request("GET", "/api/analysis/results")
            self.add(m, "分析结果列表", "GET", "/api/analysis/results", resp, elapsed)
        except Exception as e:
            self.results.append(TestResult(m, "分析结果列表", "GET", "/api/analysis/results", "FAIL", detail=str(e)))

        try:
            resp, elapsed = self._request("POST", "/api/analysis/process")
            self.add(m, "废弃端点应返回410", "POST", "/api/analysis/process", resp, elapsed, expect_codes=[410])
        except Exception as e:
            self.results.append(TestResult(m, "废弃端点", "POST", "/api/analysis/process", "FAIL", detail=str(e)))

        try:
            resp, elapsed = self._request("GET", "/api/analysis/l7d-data")
            self.add(m, "L7D数据", "GET", "/api/analysis/l7d-data", resp, elapsed, expect_codes=[200, 404])
        except Exception as e:
            self.results.append(TestResult(m, "L7D数据", "GET", "/api/analysis/l7d-data", "FAIL", detail=str(e)))

    # ===== 8. 出价管理 =====
    def test_bids(self):
        m = "出价管理"
        if not self.token:
            self.skip(m, "全部", "GET", "/api/bids/strategies", "未登录")
            return
        endpoints = [
            ("出价策略", "GET", "/api/bids/strategies"),
            ("关键词CPC", "GET", "/api/bids/keywords"),
        ]
        for name, method, path in endpoints:
            try:
                resp, elapsed = self._request(method, path)
                self.add(m, name, method, path, resp, elapsed)
            except Exception as e:
                self.results.append(TestResult(m, name, method, path, "FAIL", detail=str(e)))

    # ===== 9. 仪表板 =====
    def test_dashboard(self):
        m = "仪表板"
        # 员工洞察(任意角色都可以)
        if self.token:
            try:
                resp, elapsed = self._request("GET", "/api/dashboard/employee-insights")
                self.add(m, "员工洞察(组员)", "GET", "/api/dashboard/employee-insights", resp, elapsed)
            except Exception as e:
                self.results.append(TestResult(m, "员工洞察", "GET", "/api/dashboard/employee-insights", "FAIL", detail=str(e)))

        if not self.manager_token:
            self.skip(m, "经理专用端点", "GET", "/api/dashboard/overview", "无经理token")
            return
        endpoints = [
            ("总览", "GET", "/api/dashboard/overview"),
            ("趋势数据", "GET", "/api/dashboard/trend"),
            ("员工列表", "GET", "/api/dashboard/employees"),
            ("平台汇总(旧)", "GET", "/api/dashboard/platform-summary"),
            ("账号详情(旧)", "GET", "/api/dashboard/account-details"),
        ]
        for name, method, path in endpoints:
            try:
                resp, elapsed = self._request(method, path, token=self.manager_token)
                self.add(m, name, method, path, resp, elapsed)
            except Exception as e:
                self.results.append(TestResult(m, name, method, path, "FAIL", detail=str(e)))

        # 组长测试
        if self.leader_token:
            try:
                resp, elapsed = self._request("GET", "/api/dashboard/employee-insights", token=self.leader_token)
                self.add(m, "员工洞察(组长)", "GET", "/api/dashboard/employee-insights", resp, elapsed)
            except Exception as e:
                self.results.append(TestResult(m, "员工洞察(组长)", "GET", "/api/dashboard/employee-insights", "FAIL", detail=str(e)))

    # ===== 10. 费用管理 =====
    def test_expenses(self):
        m = "费用管理"
        if not self.token:
            self.skip(m, "全部", "GET", "/api/expenses/summary", "未登录")
            return
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        month_ago = (date.today() - timedelta(days=30)).isoformat()
        endpoints = [
            ("费用汇总", "GET", f"/api/expenses/summary?start_date={month_ago}&end_date={yesterday}"),
            ("费用明细", "GET", f"/api/expenses/cost-detail?start_date={month_ago}&end_date={yesterday}"),
            ("MCC费用明细", "GET", f"/api/expenses/mcc-cost-detail?start_date={month_ago}&end_date={yesterday}"),
            ("每日费用", "GET", f"/api/expenses/daily?start_date={month_ago}&end_date={yesterday}"),
        ]
        for name, method, path in endpoints:
            try:
                resp, elapsed = self._request(method, path)
                self.add(m, name, method, path, resp, elapsed)
            except Exception as e:
                self.results.append(TestResult(m, name, method, path, "FAIL", detail=str(e)))

    # ===== 11. 报告 =====
    def test_reports(self):
        m = "报告模块"
        token = self.manager_token or self.leader_token
        if not token:
            self.skip(m, "全部(经理/组长)", "GET", "/api/reports/financial", "无经理/组长token")
            return
        role_name = "经理" if self.manager_token else "组长"
        endpoints = [
            ("财务报告", "GET", "/api/reports/financial"),
            ("月度报告", "GET", "/api/reports/monthly"),
            ("季度报告", "GET", "/api/reports/quarterly"),
            ("年度报告", "GET", "/api/reports/yearly"),
        ]
        for name, method, path in endpoints:
            try:
                resp, elapsed = self._request(method, path, token=token)
                self.add(m, f"{name}({role_name})", method, path, resp, elapsed)
            except Exception as e:
                self.results.append(TestResult(m, name, method, path, "FAIL", detail=str(e)))

    # ===== 12. AI/Gemini =====
    def test_gemini(self):
        m = "AI/Gemini"
        if not self.token:
            self.skip(m, "全部", "GET", "/api/gemini/reports", "未登录")
            return
        endpoints = [
            ("AI报告列表", "GET", "/api/gemini/reports"),
            ("用户提示词", "GET", "/api/gemini/user-prompt?prompt_type=l7d"),
            ("营销日历", "GET", "/api/gemini/marketing-calendar/US"),
        ]
        for name, method, path in endpoints:
            try:
                resp, elapsed = self._request(method, path)
                self.add(m, name, method, path, resp, elapsed)
            except Exception as e:
                self.results.append(TestResult(m, name, method, path, "FAIL", detail=str(e)))

    # ===== 13. 广告系列管理 =====
    def test_ad_campaigns(self):
        m = "广告系列"
        if not self.token:
            self.skip(m, "全部", "GET", "/api/ad-campaigns", "未登录")
            return
        try:
            resp, elapsed = self._request("GET", "/api/ad-campaigns")
            self.add(m, "列出广告系列", "GET", "/api/ad-campaigns", resp, elapsed)
        except Exception as e:
            self.results.append(TestResult(m, "列出广告系列", "GET", "/api/ad-campaigns", "FAIL", detail=str(e)))

    # ===== 14. 导出 =====
    def test_export(self):
        m = "数据导出"
        if not self.token:
            self.skip(m, "全部", "GET", "/api/export/analysis", "未登录")
            return
        try:
            resp, elapsed = self._request("GET", "/api/export/analysis")
            self.add(m, "导出分析结果", "GET", "/api/export/analysis", resp, elapsed, expect_codes=[200, 404])
        except Exception as e:
            self.results.append(TestResult(m, "导出分析结果", "GET", "/api/export/analysis", "FAIL", detail=str(e)))

    # ===== 15. 上传历史 =====
    def test_upload(self):
        m = "文件上传"
        if not self.token:
            self.skip(m, "全部", "GET", "/api/upload/history", "未登录")
            return
        try:
            resp, elapsed = self._request("GET", "/api/upload/history")
            self.add(m, "上传历史", "GET", "/api/upload/history", resp, elapsed)
        except Exception as e:
            self.results.append(TestResult(m, "上传历史", "GET", "/api/upload/history", "FAIL", detail=str(e)))

    # ===== 16. 用户管理 =====
    def test_users(self):
        m = "用户管理"
        if not self.manager_token:
            self.skip(m, "全部(经理专用)", "GET", "/api/users/", "无经理token")
            return
        try:
            resp, elapsed = self._request("GET", "/api/users/", token=self.manager_token)
            self.add(m, "列出用户", "GET", "/api/users/", resp, elapsed)
        except Exception as e:
            self.results.append(TestResult(m, "列出用户", "GET", "/api/users/", "FAIL", detail=str(e)))

    # ===== 17. 团队管理 =====
    def test_team(self):
        m = "团队管理"

        # 员工: 我的信息（任意角色都可）
        if self.token:
            try:
                resp, elapsed = self._request("GET", "/api/team/me/info")
                self.add(m, "我的信息(组员)", "GET", "/api/team/me/info", resp, elapsed)
            except Exception as e:
                self.results.append(TestResult(m, "我的信息(组员)", "GET", "/api/team/me/info", "FAIL", detail=str(e)))

        # 组长端点
        if self.leader_token:
            leader_endpoints = [
                ("团队统计(组长)", "GET", "/api/team/stats/teams"),
                ("成员排名(组长)", "GET", "/api/team/stats/ranking"),
                ("用户列表(组长)", "GET", "/api/team/users"),
            ]
            for name, method, path in leader_endpoints:
                try:
                    resp, elapsed = self._request(method, path, token=self.leader_token)
                    self.add(m, name, method, path, resp, elapsed)
                except Exception as e:
                    self.results.append(TestResult(m, name, method, path, "FAIL", detail=str(e)))

        # 经理端点
        if not self.manager_token:
            self.skip(m, "经理专用端点", "GET", "/api/team/teams", "无经理token")
            return
        mgr_endpoints = [
            ("团队列表(经理)", "GET", "/api/team/teams"),
            ("用户列表(经理)", "GET", "/api/team/users"),
            ("团队统计(经理)", "GET", "/api/team/stats/teams"),
            ("成员排名(经理)", "GET", "/api/team/stats/ranking"),
        ]
        for name, method, path in mgr_endpoints:
            try:
                resp, elapsed = self._request(method, path, token=self.manager_token)
                self.add(m, name, method, path, resp, elapsed)
            except Exception as e:
                self.results.append(TestResult(m, name, method, path, "FAIL", detail=str(e)))

    # ===== 18. 系统管理 =====
    def test_system(self):
        m = "系统管理"
        token = self.manager_token or self.leader_token
        if not token:
            self.skip(m, "全部(经理/组长)", "GET", "/api/system/logs", "无经理/组长token")
            return
        endpoints = [
            ("系统日志", "GET", "/api/system/logs"),
            ("系统统计", "GET", "/api/system/stats"),
        ]
        for name, method, path in endpoints:
            try:
                resp, elapsed = self._request(method, path, token=token)
                self.add(m, name, method, path, resp, elapsed)
            except Exception as e:
                self.results.append(TestResult(m, name, method, path, "FAIL", detail=str(e)))

    # ===== 19. 露出功能 =====
    def test_luchu(self):
        m = "露出功能"
        if not self.token:
            self.skip(m, "全部", "GET", "/api/luchu/articles", "未登录")
            return
        endpoints = [
            ("文章列表", "GET", "/api/luchu/articles"),
            ("网站列表", "GET", "/api/luchu/websites"),
            ("提示词模板", "GET", "/api/luchu/prompts"),
            ("通知列表", "GET", "/api/luchu/notifications"),
            ("未读通知数", "GET", "/api/luchu/notifications/unread-count"),
            ("仪表板统计", "GET", "/api/luchu/stats/dashboard"),
            ("发布趋势", "GET", "/api/luchu/stats/publish-trend"),
            ("分类统计", "GET", "/api/luchu/stats/category-stats"),
            ("操作日志", "GET", "/api/luchu/logs"),
            ("操作类型", "GET", "/api/luchu/logs/actions"),
            ("资源类型", "GET", "/api/luchu/logs/resource-types"),
        ]
        for name, method, path in endpoints:
            try:
                resp, elapsed = self._request(method, path)
                self.add(m, name, method, path, resp, elapsed)
            except Exception as e:
                self.results.append(TestResult(m, name, method, path, "FAIL", detail=str(e)))

        # 经理/组长专用
        mgr_token = self.manager_token or self.leader_token
        if mgr_token:
            mgr_endpoints = [
                ("待审核列表", "GET", "/api/luchu/reviews"),
                ("待发布列表", "GET", "/api/luchu/publish/ready"),
                ("发布日志", "GET", "/api/luchu/publish/logs"),
                ("审核效率", "GET", "/api/luchu/stats/review-efficiency"),
            ]
            for name, method, path in mgr_endpoints:
                try:
                    resp, elapsed = self._request(method, path, token=mgr_token)
                    self.add(m, name + "(经理/组长)", method, path, resp, elapsed)
                except Exception as e:
                    self.results.append(TestResult(m, name, method, path, "FAIL", detail=str(e)))

    # ===== 20. 阶段标签 =====
    def test_stage_label(self):
        m = "阶段标签"
        if not self.token:
            self.skip(m, "全部", "GET", "/api/stage-label/K1", "未登录")
            return
        for label in ["K1", "S1", "P1", "T2", "T1"]:
            try:
                resp, elapsed = self._request("GET", f"/api/stage-label/{label}")
                self.add(m, f"标签 {label}", "GET", f"/api/stage-label/{label}", resp, elapsed)
            except Exception as e:
                self.results.append(TestResult(m, f"标签 {label}", "GET", f"/api/stage-label/{label}", "FAIL", detail=str(e)))

    # ===== 21. Google OAuth =====
    def test_google_oauth(self):
        m = "Google OAuth"
        try:
            resp, elapsed = self._request("GET", "/api/google-oauth/authorize", no_auth=True)
            self.add(m, "OAuth授权URL", "GET", "/api/google-oauth/authorize", resp, elapsed, expect_codes=[200, 400, 422, 500])
            if resp.status_code in (400, 500):
                self.warn(m, "OAuth未配置", "GET", "/api/google-oauth/authorize", "OAuth可能未配置client_id/secret(已改用服务账号)")
        except Exception as e:
            self.results.append(TestResult(m, "OAuth授权URL", "GET", "/api/google-oauth/authorize", "FAIL", detail=str(e)))

    # ===== 22. 平台专用 API =====
    def test_platform_specific(self):
        m = "平台专用API"
        if not self.token:
            self.skip(m, "全部", "GET", "/api/collabglow/test-connection", "未登录")
            return
        endpoints = [
            ("CollabGlow连接测试", "GET", "/api/collabglow/test-connection"),
            ("LinkHaitao连接测试", "GET", "/api/linkhaitao/test-connection"),
        ]
        for name, method, path in endpoints:
            try:
                resp, elapsed = self._request(method, path)
                self.add(m, name, method, path, resp, elapsed, expect_codes=[200, 400, 422, 500])
            except Exception as e:
                self.results.append(TestResult(m, name, method, path, "FAIL", detail=str(e)))

    # ===== 23. 权限边界测试 =====
    def test_permission_boundaries(self):
        m = "权限边界"
        if not self.token:
            self.skip(m, "全部", "GET", "/api/dashboard/overview", "未登录")
            return

        # 组员不应能访问经理接口
        try:
            resp, elapsed = self._request("GET", "/api/dashboard/overview")
            blocked = resp.status_code in (401, 403)
            self.add(m, "组员禁访经理总览", "GET", "/api/dashboard/overview", resp, elapsed, expect_codes=[401, 403])
        except Exception as e:
            self.results.append(TestResult(m, "组员禁访经理总览", "GET", "/api/dashboard/overview", "FAIL", detail=str(e)))

        try:
            resp, elapsed = self._request("GET", "/api/team/teams")
            self.add(m, "组员禁访团队列表", "GET", "/api/team/teams", resp, elapsed, expect_codes=[401, 403])
        except Exception as e:
            self.results.append(TestResult(m, "组员禁访团队列表", "GET", "/api/team/teams", "FAIL", detail=str(e)))

        # 未认证不应能访问
        try:
            resp, elapsed = self._request("GET", "/api/auth/me", no_auth=True)
            self.add(m, "未认证禁访/me", "GET", "/api/auth/me", resp, elapsed, expect_codes=[401, 403])
        except Exception as e:
            self.results.append(TestResult(m, "未认证禁访/me", "GET", "/api/auth/me", "FAIL", detail=str(e)))

    # ===== 运行全部测试 =====
    def run_all(self):
        print("=" * 70)
        print("  Google Analysis 全系统 API 测试")
        print(f"  目标: {self.base_url}")
        print(f"  时间: {date.today().isoformat()}")
        print(f"  组员: {self.username}")
        print(f"  经理: {self.manager_username or '(未提供)'}")
        print(f"  组长: {self.leader_username or '(未提供)'}")
        print("=" * 70)
        print()

        tests = [
            self.test_health,
            self.test_auth,
            self.test_mcc,
            self.test_affiliate,
            self.test_google_ads_data,
            self.test_platform_data,
            self.test_affiliate_transactions,
            self.test_analysis,
            self.test_bids,
            self.test_dashboard,
            self.test_expenses,
            self.test_reports,
            self.test_gemini,
            self.test_ad_campaigns,
            self.test_export,
            self.test_upload,
            self.test_users,
            self.test_team,
            self.test_system,
            self.test_luchu,
            self.test_stage_label,
            self.test_google_oauth,
            self.test_platform_specific,
            self.test_permission_boundaries,
        ]

        for test_fn in tests:
            try:
                test_fn()
            except Exception as e:
                print(f"  [ERROR] {test_fn.__name__}: {e}")
            time.sleep(0.1)

        self.print_report()

    def print_report(self):
        print()
        print("=" * 90)
        print("  测试结果报告")
        print("=" * 90)

        current_module = ""
        pass_count = fail_count = skip_count = warn_count = 0

        for r in self.results:
            if r.module != current_module:
                current_module = r.module
                print(f"\n  [{current_module}]")

            icon = {"PASS": "OK", "FAIL": "XX", "SKIP": "--", "WARN": "!!"}[r.status]
            time_str = f"{r.response_time_ms}ms" if r.response_time_ms else ""
            detail_str = f" | {r.detail[:80]}" if r.detail else ""
            print(f"    [{icon}] {r.name:<35} {r.method:<5} {r.path:<50} {time_str:>8}{detail_str}")

            if r.status == "PASS":
                pass_count += 1
            elif r.status == "FAIL":
                fail_count += 1
            elif r.status == "SKIP":
                skip_count += 1
            elif r.status == "WARN":
                warn_count += 1

        total = len(self.results)
        print()
        print("=" * 90)
        print(f"  总计: {total} 项 | PASS: {pass_count} | FAIL: {fail_count} | WARN: {warn_count} | SKIP: {skip_count}")
        pass_rate = (pass_count / (total - skip_count) * 100) if (total - skip_count) > 0 else 0
        print(f"  通过率: {pass_rate:.1f}% (排除SKIP)")
        print("=" * 90)

        if fail_count > 0:
            print("\n  [失败项汇总]")
            for r in self.results:
                if r.status == "FAIL":
                    print(f"    XX {r.module} > {r.name}: HTTP {r.status_code} {r.detail[:100]}")

        if warn_count > 0:
            print("\n  [警告项汇总]")
            for r in self.results:
                if r.status == "WARN":
                    print(f"    !! {r.module} > {r.name}: {r.detail[:100]}")


def main():
    parser = argparse.ArgumentParser(description="Google Analysis 全系统 API 测试")
    parser.add_argument("--base-url", default="https://api.google-data-analysis.top",
                        help="后端 API 基础 URL")
    parser.add_argument("--username", default="wj07", help="组员用户名 (默认: wj07)")
    parser.add_argument("--password", default="", help="组员密码")
    parser.add_argument("--manager-username", default="", help="经理用户名 (应为: manager)")
    parser.add_argument("--manager-password", default="", help="经理密码")
    parser.add_argument("--leader-username", default="", help="组长用户名 (如: wjzu)")
    parser.add_argument("--leader-password", default="", help="组长密码")
    args = parser.parse_args()

    if not args.password:
        print("=" * 60)
        print("  Google Analysis 全系统测试脚本")
        print("=" * 60)
        print()
        print("用法:")
        print(f"  python -m scripts.full_system_test \\")
        print(f"    --username wj07 --password YOUR_PASSWORD \\")
        print(f"    --manager-username manager --manager-password MGR_PASSWORD \\")
        print(f"    --leader-username wjzu --leader-password LEADER_PASSWORD")
        print()
        print("角色体系:")
        print("  manager  - 经理: manager")
        print("  leader   - 组长: wjzu / jyzu / yzzu")
        print("  member   - 组员: wj01-wj10 / jy01-jy10 / yz01-yz10")
        print()
        sys.exit(1)

    suite = TestSuite(
        base_url=args.base_url.rstrip("/"),
        username=args.username,
        password=args.password,
        manager_username=args.manager_username,
        manager_password=args.manager_password,
        leader_username=args.leader_username,
        leader_password=args.leader_password,
    )
    suite.run_all()


if __name__ == "__main__":
    main()
