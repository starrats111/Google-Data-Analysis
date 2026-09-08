/**
 * D-328：落地页归属复核 —— 「这个域名不像商家的，但它会不会其实就是商家自己的？」
 *
 * 背景（wj11 2026-09-08 报障）：商家 `us.store.tp-link.com` 的联盟链落到
 * `us.store.tapo.com`，被 D-316 的同主体判据判成「停在第三方中转域名」，
 * `tracking_status` 从 ok 掉成 resolve_failed、追踪后缀被清空。她换了两次链接都一样，
 * 因为每轮重巡都会再撞上同一道闸——链接本身是活的，是判据错了。
 *
 * Tapo 是 TP-Link 的智能家居子品牌，`us.store.tapo.com` 实访标题即
 * `Tapo Store | TP-Link – TP-Link Tapo Store`，静态资源托管在 tp-link.com。
 * 但 D-316/D-318 那两条判据对它全不成立：
 *   · 互相包含：`tplink` vs `tapo`/`store` → 不成立
 *   · 共同前缀 ≥6（D-318 为姊妹域 easycanvasprints/easycanvasdesigns 加的）：`t` → 长度 1
 * 根因是那两条判据都只比**字面**，而改名子品牌与母品牌字面上本就毫无关系。
 * 靠往名单里加 `tapo → tp-link` 追不上（Adtraction 轮换域那一课已经证明过），
 * 所以这里走 D-317 的思路：**看页面自己承认是谁的**。
 *
 * 判法：只有在 D-316 即将拦下时才调用。抓一次落地页，商家品牌段出现在
 * 标题 / canonical / 静态资源域名里，就认作商家自有域放行。
 *   · tapo 那页：title 含 TP-Link、资源域含 tp-link.com → 放行
 *   · PartnerBoost 中转页（`rtrack2/` 后的 base64 解出来是 `MERCHANT UNAVAILABLE`，
 *     商家真的下线了）：title 只有 `Tips`、无 canonical、无资源域 → 继续拦下
 * 2026-09-08 三个生产样本实测均符合预期。
 *
 * 取向沿用 D-316/D-317：宁可漏判，不可错杀 —— 但**抓不到页面时按拦下处理**，
 * 不拿网络故障当放行理由（放行的代价是脏 URL 扩散进 ad_creatives.final_url 和爬取起点）。
 */
import { brandTokenOf } from "@/lib/root-domain";

/** 只读首屏这么多字节：title/canonical/资源域都在 <head> 附近，读全站徒增耗时与误放行 */
const HEAD_SCAN_BYTES = 200_000;

/** 抓页面的超时（毫秒）。巡航本身已有重试，这里失败就按拦下走，不必等太久 */
const FETCH_TIMEOUT_MS = 15_000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type LandingOwnershipVerdict =
  /** 页面自证属于商家（品牌段命中）→ 放行，D-316 不拦 */
  | "brand_hit_allow"
  /** 页面里找不到商家品牌段 → 维持 D-316 的判定，拦下 */
  | "off_merchant"
  /** 品牌段太短不足以判、或页面抓不到 → 不改变 D-316 的判定，拦下 */
  | "undetermined";

export interface LandingOwnershipResult {
  verdict: LandingOwnershipVerdict;
  /** 参与判定的品牌段（空串表示没取到可用品牌段） */
  brand: string;
  /** 命中位置，供日志与 D 号追溯用 */
  hitIn: "title" | "canonical" | "assetHost" | null;
  /** 抓取是否成功 */
  fetched: boolean;
}

/** 归一化：小写、只留字母数字。`TP-Link` → `tplink`，与 brandTokenOf 同口径 */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * 判断落地页是否自证属于该商家。
 *
 * @param landingUrl 巡航终点 URL（D-316 认定「不在商家域下」的那个）
 * @param merchantUrl user_merchants.merchant_url —— 权威商家域来源
 * @param fetchImpl 注入用，测试与自定义代理走这里；默认用全局 fetch
 */
export async function checkLandingOwnership(
  landingUrl: string,
  merchantUrl: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<LandingOwnershipResult> {
  const brand = brandTokenOf(merchantUrl);
  // 品牌段短于 3 字符或取成建站平台名（brandTokenOf 已排除）→ 没有可判的东西，维持原判
  if (!brand) return { verdict: "undetermined", brand: "", hitIn: null, fetched: false };

  let html = "";
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(landingUrl, {
        redirect: "follow",
        signal: ctl.signal,
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
      });
      const buf = await res.arrayBuffer();
      html = Buffer.from(buf.slice(0, HEAD_SCAN_BYTES)).toString("utf8");
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // 抓不到就维持 D-316 的判定，不拿网络故障当放行理由
    return { verdict: "undetermined", brand, hitIn: null, fetched: false };
  }

  if (!html.trim()) {
    return { verdict: "undetermined", brand, hitIn: null, fetched: false };
  }

  const flat = html.replace(/[\r\n]+/g, " ");

  const title = flat.match(/<title[^>]*>([^<]{0,300})/i)?.[1] ?? "";
  if (norm(title).includes(brand)) {
    return { verdict: "brand_hit_allow", brand, hitIn: "title", fetched: true };
  }

  const canonical =
    flat.match(/<link[^>]+rel=["']?canonical["']?[^>]*>/i)?.[0] ?? "";
  if (norm(canonical).includes(brand)) {
    return { verdict: "brand_hit_allow", brand, hitIn: "canonical", fetched: true };
  }

  // 静态资源域：商家自建站会把图片/字体/脚本放在母品牌域下（tapo 那页的字体全在 tp-link.com）。
  // 只看 host 段，不看路径——路径里出现品牌词太容易碰巧（如 /brands/xxx 列表页）。
  const assetHosts = new Set<string>();
  for (const m of flat.matchAll(/https?:\/\/([a-z0-9.-]{3,120})/gi)) {
    assetHosts.add(m[1].toLowerCase());
    if (assetHosts.size >= 200) break;
  }
  for (const host of assetHosts) {
    if (norm(host).includes(brand)) {
      return { verdict: "brand_hit_allow", brand, hitIn: "assetHost", fetched: true };
    }
  }

  return { verdict: "off_merchant", brand, hitIn: null, fetched: true };
}
