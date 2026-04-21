/**
 * 图片 URL 规范化（C-030）
 *
 * 主要处理各电商/建站平台 CDN 的"模板变量占位符"，
 * 把它们替换成具体数值后，图片才能被 CDN 正确返回 200。
 *
 * 典型场景：Shopify 的 Liquid 模板会把图片 URL 存为
 *   https://cdn.shopify.com/s/files/1/xxx/foo_{width}x.jpg
 * 或 URL 编码形式
 *   https://cdn.shopify.com/s/files/1/xxx/foo_%7Bwidth%7Dx.jpg
 * 这种 URL 直接访问时 Shopify CDN 返回 HTTP 404。
 *
 * 调用点（双保险）：
 *   1) crawler.ts `upgradeCdnThumbnails` → 爬入库前的主修复
 *   2) image-proxy/route.ts fetch 前 → 兜底旧数据 + 浏览器直连
 */

/**
 * 规范化图片 URL 中的模板占位符。
 * - 始终返回合法字符串；对空/非 http(s) 串不做修改。
 * - 替换策略：`{width}` → "2048"（Google Ads 推荐 1200×628 以上，取 2048 无损）；
 *             `{height}` → "" （让 CDN 按宽度自适应，避免强制裁切）。
 * - 同时处理 URL 编码形式 `%7Bwidth%7D` / `%7Bheight%7D`。
 * - 清理替换后可能残留的 `x.jpg` 末尾 `x` 在空 height 时（如 `_2048x.jpg` 是合法的，无需清理）。
 */
export function normalizeImageUrl(url: string): string {
  if (!url || typeof url !== "string") return url;
  if (!url.startsWith("http://") && !url.startsWith("https://")) return url;

  let out = url;

  // Shopify / 通用 Liquid 模板占位符
  out = out
    .replace(/%7Bwidth%7D/gi, "2048")
    .replace(/%7Bheight%7D/gi, "")
    .replace(/\{width\}/g, "2048")
    .replace(/\{height\}/g, "");

  return out;
}

/** 检查 URL 是否还残留任何已知模板占位符（便于调用方判断是否触发二次重试） */
export function hasLiquidPlaceholder(url: string): boolean {
  if (!url) return false;
  return /%7B(?:width|height)%7D|\{(?:width|height)\}/i.test(url);
}
