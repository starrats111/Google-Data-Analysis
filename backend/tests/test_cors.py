"""
CORS 配置测试

验证 CORS 白名单和正则表达式的安全性，确保：
1. 所有合法的域名都能通过
2. 所有恶意的域名都被拒绝
3. 正则表达式在生产环境和开发环境下都能正确工作

运行方式：
- 使用 pytest: pytest tests/test_cors.py -v
- 独立运行: python tests/test_cors.py
"""
try:
    import pytest
except ImportError:
    pytest = None

import re

# 从 main.py 导入 CORS 配置
# 为了避免启动整个应用，我们直接复制配置进行测试
ALLOWED_ORIGINS = [
    "https://google-data-analysis.top",
    "https://www.google-data-analysis.top",
    "https://api.google-data-analysis.top",
    "https://google-data-analysis.pages.dev",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
]

ALLOWED_ORIGIN_REGEX = r"^(https://([a-z0-9-]+\.)?google-data-analysis\.(pages\.dev|top)|https://www\.google-data-analysis\.top|https://api\.google-data-analysis\.top|https?://(localhost|127\.0\.0\.1)(:\d+)?)$"


def is_origin_allowed(origin: str) -> bool:
    """检查 origin 是否被允许"""
    # 先检查白名单
    if origin in ALLOWED_ORIGINS:
        return True
    # 再检查正则表达式
    if re.match(ALLOWED_ORIGIN_REGEX, origin):
        return True
    return False


class TestCORSWhitelist:
    """测试 CORS 白名单"""

    def test_production_domains_allowed(self):
        """测试生产环境域名应该被允许"""
        allowed_domains = [
            "https://google-data-analysis.top",
            "https://www.google-data-analysis.top",
            "https://api.google-data-analysis.top",
            "https://google-data-analysis.pages.dev",
        ]
        for domain in allowed_domains:
            assert is_origin_allowed(domain), f"生产域名应该被允许: {domain}"

    def test_development_domains_allowed(self):
        """测试开发环境域名应该被允许"""
        dev_domains = [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:8000",
            "http://127.0.0.1:8000",
        ]
        for domain in dev_domains:
            assert is_origin_allowed(domain), f"开发域名应该被允许: {domain}"


class TestCORSRegex:
    """测试 CORS 正则表达式"""

    def test_cloudflare_preview_deployments_allowed(self):
        """测试 Cloudflare Pages 预览部署域名应该被允许"""
        preview_domains = [
            # 标准预览部署
            "https://abc123.google-data-analysis.pages.dev",
            "https://feature-branch.google-data-analysis.pages.dev",
            "https://123-preview.google-data-analysis.pages.dev",
            # 带有连字符的分支名
            "https://fix-cors-issue.google-data-analysis.pages.dev",
            "https://v1-2-3.google-data-analysis.pages.dev",
        ]
        for domain in preview_domains:
            assert is_origin_allowed(domain), f"Cloudflare 预览域名应该被允许: {domain}"

    def test_localhost_with_different_ports_allowed(self):
        """测试 localhost 不同端口应该被允许"""
        localhost_variants = [
            "http://localhost",
            "http://localhost:80",
            "http://localhost:8080",
            "http://localhost:4000",
            "http://127.0.0.1",
            "http://127.0.0.1:80",
            "http://127.0.0.1:8080",
            "https://localhost",
            "https://localhost:443",
            "https://127.0.0.1:443",
        ]
        for domain in localhost_variants:
            assert is_origin_allowed(domain), f"localhost 变体应该被允许: {domain}"


class TestCORSSecurityRejection:
    """测试 CORS 安全性 - 确保恶意域名被拒绝"""

    def test_subdomain_hijacking_rejected(self):
        """测试子域名劫持攻击应该被拒绝"""
        malicious_domains = [
            # 尝试在后面添加恶意域名
            "https://google-data-analysis.pages.dev.attacker.com",
            "https://google-data-analysis.top.evil.com",
            # 尝试在前面添加恶意域名
            "https://attacker.google-data-analysis.pages.dev.evil.com",
        ]
        for domain in malicious_domains:
            assert not is_origin_allowed(domain), f"子域名劫持应该被拒绝: {domain}"

    def test_similar_domain_rejected(self):
        """测试相似域名攻击应该被拒绝"""
        similar_domains = [
            "https://google-data-analysis-fake.pages.dev",
            "https://fake-google-data-analysis.pages.dev",
            "https://google-data-analysis.evil.dev",
            "https://google-data-analysis.pages.evil",
            "https://googledata-analysis.pages.dev",
            "https://google-dataanalysis.pages.dev",
        ]
        for domain in similar_domains:
            assert not is_origin_allowed(domain), f"相似域名应该被拒绝: {domain}"

    def test_http_production_rejected(self):
        """测试生产环境的 HTTP（非 HTTPS）应该被拒绝"""
        http_domains = [
            "http://google-data-analysis.top",
            "http://www.google-data-analysis.top",
            "http://api.google-data-analysis.top",
            "http://google-data-analysis.pages.dev",
        ]
        for domain in http_domains:
            assert not is_origin_allowed(domain), f"生产环境 HTTP 应该被拒绝: {domain}"

    def test_random_domains_rejected(self):
        """测试随机域名应该被拒绝"""
        random_domains = [
            "https://example.com",
            "https://google.com",
            "https://attacker.com",
            "https://malicious-site.com",
            "https://phishing.pages.dev",
            "https://evil.pages.dev",
        ]
        for domain in random_domains:
            assert not is_origin_allowed(domain), f"随机域名应该被拒绝: {domain}"

    def test_localhost_injection_rejected(self):
        """测试 localhost 注入攻击应该被拒绝"""
        injection_attempts = [
            "http://localhost.attacker.com",
            "http://localhost.evil.com:3000",
            "http://fake-localhost:3000",
            "http://localhost@evil.com",
            "http://evil.com?localhost",
        ]
        for domain in injection_attempts:
            assert not is_origin_allowed(domain), f"localhost 注入应该被拒绝: {domain}"

    def test_empty_and_null_rejected(self):
        """测试空值和 null 应该被拒绝"""
        invalid_origins = [
            "",
            "null",
            "undefined",
        ]
        for origin in invalid_origins:
            assert not is_origin_allowed(origin), f"无效 origin 应该被拒绝: {origin}"


class TestCORSEdgeCases:
    """测试 CORS 边界情况"""

    def test_case_sensitivity(self):
        """测试大小写敏感性"""
        # 域名应该是小写的，大写应该被拒绝
        uppercase_domains = [
            "https://Google-Data-Analysis.pages.dev",
            "https://GOOGLE-DATA-ANALYSIS.PAGES.DEV",
            "https://Google-Data-Analysis.top",
        ]
        for domain in uppercase_domains:
            # 正则表达式使用 [a-z0-9-]，所以大写会被拒绝
            # 但实际上浏览器会自动转换为小写，这里测试严格匹配
            assert not is_origin_allowed(domain), f"大写域名应该被拒绝（浏览器会自动转小写）: {domain}"

    def test_trailing_slash_rejected(self):
        """测试末尾斜杠应该被拒绝"""
        domains_with_slash = [
            "https://google-data-analysis.top/",
            "https://google-data-analysis.pages.dev/",
            "http://localhost:3000/",
        ]
        for domain in domains_with_slash:
            # Origin 不应该包含路径或末尾斜杠
            assert not is_origin_allowed(domain), f"末尾斜杠应该被拒绝: {domain}"

    def test_path_injection_rejected(self):
        """测试路径注入应该被拒绝"""
        path_injections = [
            "https://google-data-analysis.pages.dev/api",
            "https://google-data-analysis.pages.dev/admin",
            "http://localhost:3000/evil",
        ]
        for domain in path_injections:
            assert not is_origin_allowed(domain), f"路径注入应该被拒绝: {domain}"

    def test_query_string_rejected(self):
        """测试查询字符串应该被拒绝"""
        query_strings = [
            "https://google-data-analysis.pages.dev?evil=true",
            "http://localhost:3000?redirect=evil.com",
        ]
        for domain in query_strings:
            assert not is_origin_allowed(domain), f"查询字符串应该被拒绝: {domain}"

    def test_port_boundaries(self):
        """测试端口边界情况"""
        valid_ports = [
            "http://localhost:1",
            "http://localhost:65535",
            "http://127.0.0.1:9999",
        ]
        for domain in valid_ports:
            assert is_origin_allowed(domain), f"有效端口应该被允许: {domain}"
        
        # 无效端口格式
        invalid_ports = [
            "http://localhost:abc",
            "http://localhost:-1",
        ]
        for domain in invalid_ports:
            assert not is_origin_allowed(domain), f"无效端口应该被拒绝: {domain}"


# 运行测试
if __name__ == "__main__":
    import sys
    # 设置输出编码以支持中文
    if sys.platform == 'win32':
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    
    print("=" * 60)
    print("CORS Configuration Security Test")
    print("=" * 60)
    
    # 手动运行一些测试用例
    test_cases = [
        # (origin, expected_result, description)
        ("https://google-data-analysis.top", True, "Production domain"),
        ("https://abc123.google-data-analysis.pages.dev", True, "Cloudflare preview"),
        ("http://localhost:3000", True, "Local development"),
        ("https://evil.com", False, "Malicious domain"),
        ("https://google-data-analysis.top.evil.com", False, "Subdomain hijack"),
        ("http://google-data-analysis.top", False, "HTTP production"),
        ("https://google-data-analysis.pages.dev.evil.com", False, "Domain suffix attack"),
        ("https://fake-google-data-analysis.pages.dev", False, "Similar domain"),
        ("http://localhost:8080", True, "Localhost other port"),
        ("https://localhost", True, "Localhost HTTPS"),
    ]
    
    all_passed = True
    passed_count = 0
    failed_count = 0
    
    for origin, expected, description in test_cases:
        result = is_origin_allowed(origin)
        if result == expected:
            status = "[PASS]"
            passed_count += 1
        else:
            status = "[FAIL]"
            failed_count += 1
            all_passed = False
        print(f"{status} {description}")
        print(f"       Origin: {origin}")
        print(f"       Expected: {expected}, Actual: {result}")
        print()
    
    print("=" * 60)
    print(f"Results: {passed_count} passed, {failed_count} failed")
    print("=" * 60)
    
    if all_passed:
        print("[SUCCESS] All tests passed!")
        sys.exit(0)
    else:
        print("[FAILURE] Some tests failed!")
        sys.exit(1)

