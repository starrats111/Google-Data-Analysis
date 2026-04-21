/**
 * AD (AdsDoubler) Settings API 缓存（C-029 R1.2）
 *
 * 用途：把 /user/common/settings 的 region / cmStatus 字典缓存到内存，
 *       供 parseMerchants AD 分支把数字 ID 翻译成国家代码 / 审批状态。
 *
 * 缓存策略（07 封板 QA7~QA10）：
 *   - 粒度：按 token 缓存（QA7=A），跨 token 不串
 *   - TTL：24 小时（QA8=C）
 *   - 失败兜底：返回 null，让上层回退到"不过滤 + regions=[]"（QA9=A）
 *   - 负缓存：失败也写一个 10 分钟的空条目，避免反复打 Settings API
 *   - 商家过滤：调用方按 cmStatus.id===4 "Approved" 强过滤（QA10=B + §28.13 实证修正）
 */

// 字段说明见 设计方案.md §28.9.3 / §28.13.1
export type AdSettings = {
  regionMap: Map<number, string>;    // region.id -> abbr，例 57 -> "CZ"
  cmStatusMap: Map<number, string>;  // cmStatus.id -> desc，例 4 -> "Approved"
  fetchedAt: number;
  isNegative: boolean;               // true 表示上次 fetch 失败的负缓存
};

const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const NEGATIVE_TTL_MS = 10 * 60 * 1000;      // 10min
const FETCH_TIMEOUT_MS = 30_000;

const cache = new Map<string, AdSettings>();

const SETTINGS_URL = "https://api.adsdoubler.com/user/common/settings";

/**
 * 取 Settings 缓存，miss 时现拉；拉取失败返回 null。
 * 单次并发请求同一 token 只会发起一次 HTTP（通过 inFlight Map 去重）。
 */
const inFlight = new Map<string, Promise<AdSettings | null>>();

export async function getAdSettings(token: string): Promise<AdSettings | null> {
  if (!token) return null;
  const now = Date.now();

  const hit = cache.get(token);
  if (hit) {
    const ttl = hit.isNegative ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS;
    if (now - hit.fetchedAt < ttl) {
      return hit.isNegative ? null : hit;
    }
  }

  const pending = inFlight.get(token);
  if (pending) return pending;

  const p = fetchAdSettings(token).finally(() => { inFlight.delete(token); });
  inFlight.set(token, p);
  return p;
}

async function fetchAdSettings(token: string): Promise<AdSettings | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${SETTINGS_URL}?token=${encodeURIComponent(token)}`;
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = (await resp.json()) as Record<string, unknown>;
    const code = String(json.code ?? "");
    if (code !== "200" && code !== "0") {
      throw new Error(`AD settings code=${code} msg=${String(json.msg ?? "")}`);
    }

    const data = (json.data || {}) as Record<string, unknown>;
    const regionMap = new Map<number, string>();
    const cmStatusMap = new Map<number, string>();

    const regions = Array.isArray(data.region) ? (data.region as Record<string, unknown>[]) : [];
    for (const r of regions) {
      const id = Number(r.id);
      const abbr = String(r.abbr ?? "").trim();
      if (id > 0 && abbr) regionMap.set(id, abbr);
    }

    const cmStatus = Array.isArray(data.cmStatus) ? (data.cmStatus as Record<string, unknown>[]) : [];
    for (const s of cmStatus) {
      const id = Number(s.id);
      const desc = String(s.desc ?? "").trim();
      if (id > 0 && desc) cmStatusMap.set(id, desc);
    }

    if (regionMap.size === 0 || cmStatusMap.size === 0) {
      throw new Error(`AD settings empty: regions=${regionMap.size} cmStatus=${cmStatusMap.size}`);
    }

    const out: AdSettings = { regionMap, cmStatusMap, fetchedAt: Date.now(), isNegative: false };
    cache.set(token, out);
    console.log(`[AdSettings] fetched: regions=${regionMap.size}, cmStatus=${cmStatusMap.size}`);
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[AdSettings] fetch failed: ${msg}, write negative cache ${NEGATIVE_TTL_MS / 1000}s`);
    cache.set(token, {
      regionMap: new Map(), cmStatusMap: new Map(),
      fetchedAt: Date.now(), isNegative: true,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function _clearAdSettingsCache() {
  cache.clear();
  inFlight.clear();
}
