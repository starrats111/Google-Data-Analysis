/**
 * BUG-02 D（设计方案.md §四点五）：感知哈希（dHash）视觉去重
 *
 * 目标：去掉「不同 URL 但视觉相同/极近似」的候选图（A 词干去重挡不住的同图不同路径）。
 * 约束（低配生产机 2核2G）：
 *   - 仅处理前 maxImages 张，下载带并发上限 + 单图超时 + 总时间预算
 *   - 任何下载/解码失败 → 保留该图（绝不因去重误删真实图）
 *   - 结果按 URL 缓存（进程级 LRU），同一商家重复爬取近乎零成本
 *   - sharp 为可选依赖：加载失败则整体跳过，返回原数组（不影响主流程）
 */

type SharpModule = typeof import("sharp");
let _sharp: SharpModule | null = null;
let _sharpTried = false;
async function getSharp(): Promise<SharpModule | null> {
  if (_sharpTried) return _sharp;
  _sharpTried = true;
  try {
    _sharp = (await import("sharp")).default as unknown as SharpModule;
  } catch (e) {
    console.warn("[ImagePHash] sharp 不可用，视觉去重跳过：", e instanceof Error ? e.message : e);
    _sharp = null;
  }
  return _sharp;
}

/** dHash：9x8 灰度 → 行内相邻像素比较 → 64bit */
export async function computeDHash(buf: Buffer): Promise<bigint | null> {
  const sharp = await getSharp();
  if (!sharp) return null;
  try {
    const { data, info } = await sharp(buf)
      .resize(9, 8, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const ch = info.channels || 1;
    const px = (r: number, c: number) => data[(r * 9 + c) * ch];
    const ONE = BigInt(1);
    let hash = BigInt(0);
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        if (px(row, col) > px(row, col + 1)) {
          hash |= ONE << BigInt(row * 8 + col);
        }
      }
    }
    return hash;
  } catch {
    return null;
  }
}

export function hammingDistance(a: bigint, b: bigint): number {
  const ZERO = BigInt(0);
  const ONE = BigInt(1);
  let x = a ^ b;
  let count = 0;
  while (x > ZERO) {
    count += Number(x & ONE);
    x >>= ONE;
  }
  return count;
}

// ─── 进程级 URL → hash 缓存（LRU 简化版） ───
const HASH_CACHE_MAX = 5000;
const hashCache = new Map<string, bigint | null>();
function cacheGet(url: string): bigint | null | undefined {
  return hashCache.get(url);
}
function cacheSet(url: string, h: bigint | null) {
  if (hashCache.size >= HASH_CACHE_MAX) {
    const first = hashCache.keys().next().value;
    if (first !== undefined) hashCache.delete(first);
  }
  hashCache.set(url, h);
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchAndHash(url: string, timeoutMs: number, maxBytes: number): Promise<bigint | null> {
  try {
    const resp = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": BROWSER_UA, Accept: "image/*", Referer: "" },
    });
    if (!resp.ok) return null;
    const ct = resp.headers.get("content-type") || "";
    if (ct && !ct.startsWith("image/")) return null;
    const ab = await resp.arrayBuffer();
    if (ab.byteLength === 0 || ab.byteLength > maxBytes) return null;
    return await computeDHash(Buffer.from(ab));
  } catch {
    return null;
  }
}

export interface VisualDedupeOptions {
  maxImages?: number;
  concurrency?: number;
  perImageTimeoutMs?: number;
  totalBudgetMs?: number;
  /** hamming 距离阈值，<= 视为同图（dHash 经验值 6） */
  threshold?: number;
  maxBytes?: number;
}

/**
 * 视觉去重：对前 maxImages 张算 dHash，去掉近似重复，保留顺序；
 * 超出 maxImages 的尾部不处理、原样附加在后。算不出哈希的图一律保留。
 */
export async function dedupeByVisualHash(
  urls: string[],
  opts: VisualDedupeOptions = {},
): Promise<string[]> {
  const {
    maxImages = 40,
    concurrency = 3,
    perImageTimeoutMs = 4000,
    totalBudgetMs = 15000,
    threshold = 6,
    maxBytes = 2_000_000,
  } = opts;

  if (!Array.isArray(urls) || urls.length <= 1) return urls;

  const sharp = await getSharp();
  if (!sharp) return urls;

  const head = urls.slice(0, maxImages);
  const tail = urls.slice(maxImages);
  const deadline = Date.now() + totalBudgetMs;
  const hashes = new Map<string, bigint | null>();

  let idx = 0;
  const worker = async () => {
    while (idx < head.length) {
      const myIdx = idx++;
      const url = head[myIdx];
      if (Date.now() > deadline) {
        hashes.set(url, null); // 预算耗尽 → 视为无法判定（保留）
        continue;
      }
      const cached = cacheGet(url);
      if (cached !== undefined) {
        hashes.set(url, cached);
        continue;
      }
      const h = await fetchAndHash(url, perImageTimeoutMs, maxBytes);
      cacheSet(url, h);
      hashes.set(url, h);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, head.length) }, worker));

  const kept: bigint[] = [];
  const out: string[] = [];
  for (const url of head) {
    const h = hashes.get(url);
    if (h === null || h === undefined) {
      out.push(url); // 无法判定 → 保留
      continue;
    }
    if (kept.some((k) => hammingDistance(k, h) <= threshold)) continue; // 视觉重复，丢弃
    kept.push(h);
    out.push(url);
  }
  return out.concat(tail);
}
