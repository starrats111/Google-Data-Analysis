/**
 * 竞品文案池的数据形状与拆句去重工具。
 *
 * D-233：这些定义原本住在 kyads 的 `ad-create/semrush-client.ts` 里。SemRush 那条
 * 采集路径 kyads 生产早已停用（3UE 403、SemRush 设备数上限），真正在跑的是
 * `competitor-source.ts` 走品牌评估结果 + SerpApi 的路径，但它的返回结构仍然沿用
 * `SemRushResult`，下游 ai-asset-generator / copy-completion 都按这个形状读。
 * 所以移植时只把「形状 + 去重」摘出来，HTTP 客户端整体不搬。
 *
 * 字段名保留 SemRush 时代的命名（adsOverview / copies / creativeSamples），是为了让
 * 下游一行不改；`keywords` 现在恒为空数组（没有 SemRush 就没有这份关键词数据），
 * 品牌词改由 DataForSEO 那条链路提供。
 */

export interface AdCopyPoolKeyword {
  phrase: string;
  volume: number;
  cpc?: number | null;
  competition?: string | number | null;
  suggested_bid?: number | null;
}

export interface AdCopyPoolResult {
  domain: string;
  keywords: AdCopyPoolKeyword[];
  adsOverview: { title: string; description: string }[];
  copies: { date: string; total: number; samples: { title: string; description: string }[] };
  creativeSamples: { title: string; description: string }[];
  dedupedTitles: string[];
  dedupedDescriptions: string[];
}

/**
 * Google/SerpApi 的展示层会把多段标题用 `|`、`–`、` - ` 拼成一条，
 * 拆回独立候选才能进 RSA 的 30 字符标题位。
 */
export function dedupeAdTitles(titles: string[]): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  for (const title of titles) {
    const parts = title.split(/\s*[\|–—]\s*|\s+-\s+/);
    for (const part of parts) {
      const cleaned = part.trim();
      if (cleaned && !seen.has(cleaned)) {
        seen.add(cleaned);
        items.push(cleaned);
      }
    }
  }
  return items;
}

export function dedupeAdDescriptions(descriptions: string[]): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  for (const desc of descriptions) {
    const parts = desc.includes(".") ? desc.split(".") : [desc];
    for (const part of parts) {
      const cleaned = part.trim();
      if (!cleaned) continue;
      const sentence = `${cleaned}.`;
      if (!seen.has(sentence)) {
        seen.add(sentence);
        items.push(sentence);
      }
    }
  }
  return items;
}
