/**
 * 代理应用场景路由（D-271）——纯模块（无 prisma 依赖，供单测锁契约）
 *
 * usage_scene 从纯展示标签升级为路由键：换链接与 AI 爬取两条线共用 kyads_proxies 表，
 * 但出口严格隔离（2026-07-04/07-13 两次事故的铁律：AI 爬虫绝不许抢换链接池的并发额度，
 * 换链接也绝不许兜底到 AI 出口）。隔离从「两套存储」变成「同表场景过滤」，语义不变。
 */

export const SCENE_EXCHANGE = '换链接'
export const SCENE_AI = 'AI爬取'

/**
 * 换链接场景 where 片段。usage_scene 为 null 的历史行按换链接对待（该字段 D-254 才补，
 * 存量供应商全部是换链接用途），但绝不包含 AI爬取——过滤写漏=AI 抢 kookeey 并发额度事故重演。
 */
export function exchangeSceneWhere(): { OR: Array<{ usage_scene: string | null }> } {
  return { OR: [{ usage_scene: SCENE_EXCHANGE }, { usage_scene: null }] }
}

/** AI 爬取场景 where 片段：只认显式标记 AI爬取 的行，且按协议过滤（http 供 Puppeteer，socks5 供 Node 请求）。 */
export function aiSceneWhere(proto: 'socks5' | 'http'): { usage_scene: string; proxy_type: string } {
  return { usage_scene: SCENE_AI, proxy_type: proto }
}

/** 按换链接场景过滤（与 exchangeSceneWhere 语义一致的内存版，供告警聚合等非 DB 场景复用）。 */
export function isExchangeSceneRow(row: { usage_scene?: string | null; scene?: string | null }): boolean {
  const scene = row.usage_scene !== undefined ? row.usage_scene : row.scene
  return scene !== SCENE_AI
}
