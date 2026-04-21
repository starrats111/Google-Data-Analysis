/**
 * C-032 Sitelinks 质量过滤
 * 两层黑名单：URL 路径关键词 + 链接标题关键词
 * 命中任意一层 → 判定为低价值链接 → 丢弃
 */

const URL_PATH_BLACKLIST = [
  // 账号/身份认证工具页
  "forgot", "password", "reset-password", "signin", "sign-in",
  "logout", "log-out", "register", "account", "profile",
  // 法务/隐私页
  "disclaimer", "privacy", "terms", "cookie", "gdpr",
  "legal", "policy", "compliance", "tos",
  // 后台/内部系统
  "dashboard", "admin", "driver-area", "driverarea",
  "staff", "internal", "backend", "control-panel",
  // 错误/系统页
  "error", "/404", "/500", "notfound", "not-found", "maintenance",
  // 其他无价值
  "unsubscribe", "preferences", "accessibility", "sitemap",
];

const TITLE_BLACKLIST = [
  // 账号/工具类
  "forgot", "password", "sign in", "log in", "login", "register",
  // 法务类
  "privacy", "disclaimer", "terms", "cookie", "legal", "policy",
  // 后台/内部
  "dashboard", "driver login", "driver area", "staff", "admin",
  // 系统页
  "404", "error", "page not found", "accessibility",
  "sitemap", "unsubscribe",
];

/**
 * 判断一条 Sitelink 候选是否为低价值链接。
 * 对 URL 路径和标题分别做黑名单子串匹配（不区分大小写）。
 */
export function isLowValueSitelink(url: string, title: string): boolean {
  let path = "";
  try { path = new URL(url).pathname.toLowerCase(); } catch { path = url.toLowerCase(); }

  const t = title.toLowerCase();

  if (URL_PATH_BLACKLIST.some((kw) => path.includes(kw))) return true;
  if (TITLE_BLACKLIST.some((kw) => t.includes(kw))) return true;

  return false;
}
