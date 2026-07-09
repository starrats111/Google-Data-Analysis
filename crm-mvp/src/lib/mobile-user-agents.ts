/**
 * 移动端 User-Agent 共享库（跟链 / 刷点击 / 浏览器兜底统一取用，每次随机，避免固定单一指纹）。
 *
 * 采集口径（2026-07 现网真实形态）：
 * - 安卓 Chrome 已默认启用「UA 精简（UA Reduction）」：设备型号与系统版本一律固定为
 *   `Android 10; K`，Chrome 版本号次级位归零为 `NNN.0.0.0`。故所有真实安卓 Chrome 长得高度一致，
 *   保留少量主版本(148/149/150)差异即可，写具体机型/安卓版本反而是过时、易被识别为伪造的形态。
 * - iOS Safari 自 iOS 26 起冻结系统版本：`iPhone OS` 恒为 `18_6`，真实版本只在 `Version/26.0` 体现；
 *   iOS 18.7 则是 `18_7` + `Version/18.7`。iOS 上的 Chrome(CriOS) 仍上报真实 `iPhone OS 26_x`。
 * - 覆盖主流形态：安卓 Chrome/Edge/Firefox、iPhone Safari/Chrome、iPad Safari。
 *
 * 需定期（如每季度）跟随 Chrome/iOS 稳定版滚动更新版本号，保持"最新"。
 */
export const MOBILE_USER_AGENTS: readonly string[] = [
  // ── 安卓 Chrome（UA 精简形态：Android 10; K）──
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36",
  // 安卓平板 Chrome（无 "Mobile" 标记）
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
  // 安卓 Edge
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36 EdgA/150.0.0.0",
  // 安卓 Firefox（不做 UA 精简，仍上报真实安卓版本）
  "Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0",
  "Mozilla/5.0 (Android 14; Mobile; rv:139.0) Gecko/139.0 Firefox/139.0",

  // ── iPhone Safari（iOS 26 冻结系统版本为 18_6，版本见 Version/*）──
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  // iPhone Chrome（CriOS，上报真实 iOS 版本）
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/150.0.7871.63 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/149.0.7827.48 Mobile/15E148 Safari/604.1",

  // ── iPad Safari ──
  "Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1",
];

/** 从移动端 UA 库随机取一条（每次调用都随机，避免固定单一指纹）。 */
export function pickMobileUserAgent(): string {
  return MOBILE_USER_AGENTS[Math.floor(Math.random() * MOBILE_USER_AGENTS.length)];
}
