import json
import time
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

RESULT = {
    "home": {},
    "errors": {
        "pageerror_events": [],
        "console_events": [],
        "window_errors": [],
        "window_unhandled_rejections": [],
        "window_console_errors": []
    },
    "loaded_assets": [],
    "mcc_accounts": {}
}

INIT_SCRIPT = """
(() => {
  window.__capturedWindowErrors = [];
  window.__capturedUnhandledRejections = [];
  window.__capturedConsoleErrors = [];

  window.addEventListener('error', (e) => {
    window.__capturedWindowErrors.push({
      message: e.message || null,
      filename: e.filename || null,
      lineno: e.lineno || null,
      colno: e.colno || null,
      stack: e.error && e.error.stack ? String(e.error.stack) : null
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    window.__capturedUnhandledRejections.push({
      message: reason && reason.message ? String(reason.message) : String(reason),
      stack: reason && reason.stack ? String(reason.stack) : null
    });
  });

  const originalConsoleError = console.error.bind(console);
  console.error = (...args) => {
    const normalized = args.map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }).join(' ');
    window.__capturedConsoleErrors.push(normalized);
    return originalConsoleError(...args);
  };
})();
"""

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(ignore_https_errors=True)
        page = context.new_page()

        asset_urls = []

        def on_console(msg):
            try:
                loc = msg.location
            except Exception:
                loc = None
            RESULT["errors"]["console_events"].append({
                "type": msg.type,
                "text": msg.text,
                "location": loc,
            })

        def on_pageerror(err):
            RESULT["errors"]["pageerror_events"].append({
                "message": str(err),
                "stack": getattr(err, "stack", None),
                "name": getattr(err, "name", None),
            })

        def on_response(resp):
            url = resp.url
            if "/assets/" in url and ".js" in url:
                asset_urls.append({
                    "url": url,
                    "status": resp.status,
                })

        page.on("console", on_console)
        page.on("pageerror", on_pageerror)
        page.on("response", on_response)

        page.add_init_script(INIT_SCRIPT)

        try:
            page.goto("http://localhost:4173", wait_until="networkidle", timeout=60000)
            page.wait_for_timeout(2000)
        except PlaywrightTimeoutError as e:
            RESULT["home"]["goto_timeout"] = str(e)

        RESULT["home"]["final_url"] = page.url
        RESULT["home"]["title"] = page.title()

        error_locator = page.locator("text=页面出现错误")
        error_count = error_locator.count()
        RESULT["home"]["page_error_text_count"] = error_count

        visible = False
        if error_count > 0:
            try:
                visible = error_locator.first.is_visible(timeout=2000)
            except Exception:
                visible = False
        RESULT["home"]["page_error_text_visible"] = visible

        captured = page.evaluate(
            """() => ({
                windowErrors: window.__capturedWindowErrors || [],
                unhandledRejections: window.__capturedUnhandledRejections || [],
                consoleErrors: window.__capturedConsoleErrors || []
            })"""
        )
        RESULT["errors"]["window_errors"] = captured.get("windowErrors", [])
        RESULT["errors"]["window_unhandled_rejections"] = captured.get("unhandledRejections", [])
        RESULT["errors"]["window_console_errors"] = captured.get("consoleErrors", [])

        dedup = []
        seen = set()
        for a in asset_urls:
            key = (a["url"], a["status"])
            if key in seen:
                continue
            seen.add(key)
            dedup.append(a)
        RESULT["loaded_assets"] = dedup

        # Step 5: mcc-accounts 获取脚本
        page.goto("http://localhost:4173/mcc-accounts", wait_until="networkidle", timeout=60000)
        page.wait_for_timeout(2000)

        RESULT["mcc_accounts"]["url"] = page.url

        # Detect if redirected to login
        login_hint = page.locator("text=登录").count() > 0 or "/login" in page.url.lower()
        RESULT["mcc_accounts"]["likely_login_page"] = login_hint

        script_result = {
            "clicked": False,
            "script_length": 0,
            "contains_authuser": False,
            "contains_continueUrl": False,
            "script_sample": "",
            "error": None,
        }

        if not login_hint:
            try:
                btn = page.locator("button:has(.anticon-file-text)").first
                btn.wait_for(state="visible", timeout=15000)
                btn.click()
                script_result["clicked"] = True

                textarea = page.locator(".ant-modal textarea").first
                textarea.wait_for(state="visible", timeout=15000)
                content = textarea.input_value() or ""
                script_result["script_length"] = len(content)
                script_result["contains_authuser"] = "authuser=" in content
                script_result["contains_continueUrl"] = "continueUrl=" in content
                script_result["script_sample"] = content[:600]
            except Exception as e:
                script_result["error"] = str(e)
        else:
            script_result["error"] = "页面疑似登录态拦截，未执行点击获取脚本"

        RESULT["mcc_accounts"]["script_check"] = script_result

        browser.close()


if __name__ == "__main__":
    run()
    print(json.dumps(RESULT, ensure_ascii=False, indent=2))
