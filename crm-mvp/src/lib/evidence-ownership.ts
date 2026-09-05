/**
 * D-317：证据页归属校验 —— 「爬到的这页，到底是不是这个商家的？」
 *
 * 背景：D-316 只守住「联盟链解析」这一个入口。错 URL 还能从别的路径进来——员工手填 final_url、
 * ccTLD 兜底换域、D-096 落地域校正。而生成侧现有三道闸没有一道负责问归属：
 *   · L2 上下文守门只数**数量**（pageText 字数 / semrush 标题数 / 产品数），一张内容丰满的错页
 *     （Adtraction 招商页 7577 字）照样满分放行；
 *   · Step 6 证据 prompt 只管「别编造」，不管证据本身是谁的；
 *   · Step 7 相似度比的是文案↔关键词，而关键词有一路同样来自那张错页 —— 同源自洽，分数反而高。
 * 结果就是 07 报的 Tchibo 事故：文案通顺、合规、零报错，只是跟商家卖什么毫无关系。
 *
 * 判法要两个信号**同时失守**才拦：
 *   ① host 对不上商家域（复用 D-316 的品牌级比对，放过 ccTLD / 子域 / 建站平台子域）；
 *   ② 商家品牌词在标题、meta、正文里一次都没出现。
 * 只有 ①② 都成立才判 `off_merchant`。商家换域名、merchant_url 填的是旧域这类情况，
 * 品牌词一定在正文里，② 不成立 → 判 `brand_hit_allow` 放行并记一笔。
 * 取向与 D-316 一致：宁可漏判，不可错杀。
 */
import { brandTokenOf, landingMatchesTarget } from "@/lib/root-domain";

export type EvidenceOwnershipVerdict =
  /** 素材页就在商家域下，或压根没有可判的品牌段 → 正常放行 */
  | "ok"
  /** host 对不上但正文里有品牌词 → 放行，只记日志（商家自有的另一个域） */
  | "brand_hit_allow"
  /** host 对不上且正文里没有品牌词 → 判为第三方中转/无关站点，停掉文案生成 */
  | "off_merchant";

export interface EvidenceOwnershipInput {
  /** 本次爬取的实际来源 URL（crawl_cache.crawledFromUrl），拿不到就传当前 merchantUrl */
  evidenceUrl: string | null | undefined;
  /** user_merchants.merchant_url —— 权威的商家域来源 */
  merchantUrl: string | null | undefined;
  title?: string | null;
  metaDescription?: string | null;
  pageText?: string | null;
  /**
   * 页面自身的其余文本（导航项、features 等）。
   *
   * ⚠️ 绝不要把 `semrushTitles` 放进来：那是**按商家域**查回来的 organic 标题，必然带品牌词，
   * 一掺进来 brandHit 恒为 true，这道闸就等于没有。这里只收爬到的那一页自己的字。
   */
  extraText?: (string | null | undefined)[] | null;
}

export interface EvidenceOwnershipResult {
  verdict: EvidenceOwnershipVerdict;
  /** 参与判定的品牌段（空串表示品牌段太短，本次不判） */
  brand: string;
  /** host 是否对不上商家域 */
  hostOff: boolean;
  /** 品牌词是否在标题/meta/正文里出现过 */
  brandHit: boolean;
}

/** 正文里搜品牌词时只取前这么多字符——首屏之外基本是页脚/推荐位，搜太深徒增误放行 */
const TEXT_SCAN_LIMIT = 20_000;

export function checkEvidenceOwnership(
  input: EvidenceOwnershipInput,
): EvidenceOwnershipResult {
  const brand = brandTokenOf(input.merchantUrl);
  const evidenceUrl = (input.evidenceUrl || "").trim();

  // 品牌段短于 3 字符、或压根没有素材来源 URL 可判 → 不判，放行
  if (!brand || !evidenceUrl || !input.merchantUrl) {
    return { verdict: "ok", brand, hostOff: false, brandHit: true };
  }

  const hostOff = !landingMatchesTarget(evidenceUrl, input.merchantUrl);
  if (!hostOff) {
    return { verdict: "ok", brand, hostOff: false, brandHit: true };
  }

  const hay = [
    input.title ?? "",
    input.metaDescription ?? "",
    (input.extraText ?? []).filter(Boolean).join(" "),
    (input.pageText ?? "").slice(0, TEXT_SCAN_LIMIT),
  ]
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const brandHit = hay.includes(brand);

  return {
    verdict: brandHit ? "brand_hit_allow" : "off_merchant",
    brand,
    hostOff: true,
    brandHit,
  };
}
