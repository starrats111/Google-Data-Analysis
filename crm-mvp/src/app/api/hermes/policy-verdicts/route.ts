import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { verifyHermesToken } from "@/lib/hermes-auth";

// D-221：接收 Hermes 的禁投品类判定，回写「主营业务」+ 政策标记。
//
// 起因（07 2026-08-07）：`我的商家` 的主营业务栏 148 万行里 71% 是 `Others`/`Others>Others`/`Other`
// 这类没信息量的值——那是联盟平台自己给的分类，不是我们能改的。而 Hermes 为了防封号做的三层
// 禁投闸（HM-D71）恰好把其中一批查清楚了：抓落地页、数词频、看 Google 拒登回灌，最后得出
// 「这家其实是卖成人用品的 / 是网贷的 / 是电子烟的」。这份结论只躺在 Hermes 自己的 SQLite 里，
// CRM 界面上那些商家仍然写着 `Others>Others`，谁看谁都不知道碰不得。
//
// 两件事一起做：
//   ① category（主营业务）：只在**现值是无效值且没被人工改过**时才写，绝不覆盖真分类和人工修正；
//      写了就打 category_manual=1，否则下一轮平台同步会把它冲回 `Others`。
//   ② policy_status / policy_category_code：这对字段 CRM 本来就有，且 `prohibited` 在领取接口
//      是**硬拦**（POST /api/user/merchants 领取时直接报错）。只写主营业务只能让人「看见」，
//      填了这对字段才真的拦得住别人去投。
//
// 定级用 Hermes 的判定而不是 ad_policy_categories.restriction_level：后者把 adult / financial /
// gambling 都只算 restricted（领取只弹个警告），而 7 个被封的账号里就有一个是踩了成人内容——
// 07 的口径是这类一个都不投，所以 blocked → prohibited、review → restricted。
//
// 匹配按 (platform, merchant_id) 精确走索引；expand_domain=true 时额外按域名传播到其他平台的
// 同一个商家（一次全表 LIKE 扫描，1.5M 行、约一分钟，只在首次全量回写时开）。

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** 主营业务允许写入的英文 canonical（与前端 CATEGORY_CN 的键对齐，防止写进脏字符串） */
const ALLOWED_BUSINESS = new Set([
  "Adult", "Gambling", "Tobacco & Vape", "Weapons", "Counterfeit",
  "CBD & Cannabis", "Supplements", "Finance", "Insurance", "Crypto",
]);

/** 现值算「无效」的取值：联盟平台给的占位分类，写它没有任何信息量 */
const USELESS_CATEGORY = new Set(["", "other", "others", "others>others", "other>other", "n/a", "-"]);

const isUseless = (v: string | null | undefined) =>
  USELESS_CATEGORY.has(String(v ?? "").trim().toLowerCase());

type Verdict = {
  network: string;
  merchant_id: string;
  domain?: string;
  merchant_name?: string;
  /** blocked / review / cleared */
  verdict: string;
  /** 已映射成 CRM ad_policy_categories.category_code，如 adult / financial / tobacco */
  policy_code?: string | null;
  /** 写进主营业务的英文 canonical */
  business_category?: string | null;
  /** keyword / landing / rejection / manual */
  layer?: string | null;
  evidence?: string | null;
};

const STATUS_OF: Record<string, string> = {
  blocked: "prohibited",
  review: "restricted",
};

// D-235（2026-08-14）：域名/品牌扩散只允许这四类「整站生意」硬禁品类。
//
// 教训：Hermes 把 LH 的子项目「Klook Global - Klook Insurance」按关键词判成 financial/blocked，
// 判定携带的域名是主站 klook.com——精确域名扩散当时不限品类，把全平台 887 行 klook.com 商家
// （Klook Hotels / Tours / Car Rentals 这些纯旅游项目）全标成了 prohibited，07 指出误伤。
// 金融/保险类经常是大平台域名下的一个子产品（旅行平台卖旅行险、商城卖联名信用卡），
// 域名相同不代表主营业务相同；而 adult/gambling/cannabis/tobacco 基本是整站一种生意，
// 扩散才安全。financial 等品类只按 (platform, merchant_id) 精确写，不扩散。
const EXPAND_CODES = new Set(["adult", "gambling", "cannabis", "tobacco"]);

export async function POST(req: NextRequest) {
  const authErr = verifyHermesToken(req);
  if (authErr) return authErr;

  let body: { verdicts?: Verdict[]; expand_domain?: boolean; dry_run?: boolean };
  try {
    body = await req.json();
  } catch {
    return apiError("请求体不是合法 JSON", 400);
  }
  const list = Array.isArray(body?.verdicts) ? body.verdicts : [];
  if (!list.length) return apiError("verdicts 不能为空", 400);
  if (list.length > 2000) return apiError("单次最多 2000 条", 400);

  const expandDomain = body.expand_domain === true;
  const dryRun = body.dry_run === true;

  try {
    // 只认 ad_policy_categories 里真实存在的品类代码。Hermes 有 counterfeit 这一类而 CRM 表里没有，
    // 与其现造一行品类配置（会影响所有用户的领取规则），不如照实报回去让人决定。
    const knownCodes = new Set(
      (await prisma.ad_policy_categories.findMany({
        where: { is_deleted: 0 }, select: { category_code: true },
      })).map((c) => c.category_code),
    );

    const keys = list.map((v) => ({
      platform: String(v.network || "").toUpperCase(),
      merchant_id: String(v.merchant_id || ""),
    })).filter((k) => k.platform && k.merchant_id);

    // ── ① 按平台+MID 精确取行（走 (platform, merchant_id) 索引）──
    const rows = await prisma.user_merchants.findMany({
      where: { is_deleted: 0, OR: keys.map((k) => ({ platform: k.platform, merchant_id: k.merchant_id })) },
      select: {
        id: true, platform: true, merchant_id: true, merchant_url: true,
        category: true, category_manual: true, policy_status: true, policy_category_code: true,
      },
    });

    // verdict 索引：平台+MID → verdict；域名 → verdict（域名传播用）。
    // 域名传播只收 blocked + 四类整站品类（EXPAND_CODES，理由见其定义处的 Klook 案例），
    // review 未定性、financial 等子产品型品类都不进传播索引。
    const byKey = new Map<string, Verdict>();
    const byDomain = new Map<string, Verdict>();
    for (const v of list) {
      const k = `${String(v.network || "").toUpperCase()}|${String(v.merchant_id || "")}`;
      byKey.set(k, v);
      const d = String(v.domain || "").trim().toLowerCase();
      if (d && v.verdict === "blocked" && EXPAND_CODES.has(String(v.policy_code || ""))) {
        byDomain.set(d, v);
      }
    }

    // 每一行要写什么：id → { category?, policy_status?, policy_category_code?, verdict }
    type Plan = { category?: string; policy_status?: string; policy_category_code?: string | null; v: Verdict };
    const plans = new Map<string, Plan>();
    const unknownCodes = new Set<string>();
    let skippedManual = 0;

    const planRow = (
      row: { id: bigint; category: string | null; category_manual: number; policy_status: string | null },
      v: Verdict,
    ) => {
      const plan: Plan = { v };

      // 主营业务：只补空，不覆盖真分类，也不覆盖人工修正
      const biz = String(v.business_category || "").trim();
      if (biz && ALLOWED_BUSINESS.has(biz)) {
        if (row.category_manual === 1) {
          if (isUseless(row.category)) skippedManual++;
        } else if (isUseless(row.category)) {
          plan.category = biz;
        }
      }

      // 政策标记：blocked→prohibited、review→restricted；cleared 只认 07 亲自裁定的那种
      const st = STATUS_OF[String(v.verdict || "")];
      const code = String(v.policy_code || "").trim();
      if (st) {
        plan.policy_status = st;
        if (code) {
          if (knownCodes.has(code)) plan.policy_category_code = code;
          else unknownCodes.add(code);
        }
      } else if (v.verdict === "cleared" && v.layer === "manual") {
        // 07 手动放行：把之前种下的禁投标记解掉，否则 CRM 这边一直拦着领取，
        // 而且会通过商家情报接口回灌成 Hermes 的 crm_policy_flags 把它自己的放行推翻
        if (row.policy_status === "prohibited" || row.policy_status === "restricted") {
          plan.policy_status = "clean";
          plan.policy_category_code = null;
        }
      }

      if (plan.category !== undefined || plan.policy_status !== undefined) {
        plans.set(String(row.id), plan);
      }
    };

    for (const row of rows) {
      const v = byKey.get(`${row.platform}|${row.merchant_id}`);
      if (v) planRow(row, v);
    }
    const matchedByMid = rows.length;

    // ── ② 域名传播：同一个商家在别的平台是另一个 MID，只按 MID 写会漏掉 ──
    //
    // 这一步不是可选的锦上添花：实测 Acmejoy（就是让账号被判 SEXUALLY_EXPLICIT 的那个）
    // 在 MUI 之外还挂在 BSH 平台上、另一个 MID、12 行，只按 MID 写的话那 12 行仍是
    // `Others>Others` + `clean`，别人照样能领取去投。
    // 品类限制见 EXPAND_CODES：精确域名传播原先不限品类，被 Klook Insurance 拖死整个
    // klook.com（D-235），现在与品牌扩展一样只认 blocked + 四类整站品类。
    //
    // 写法上刻意不用 343 个 `contains`（那是 343 遍全表 LIKE）。`merchant_url` 没有索引、
    // 模糊匹配注定要全扫，那就只扫一遍：库侧把 URL 规范成裸域名，与传入域名做等值 JOIN。
    // 去 www 用 TRIM(LEADING) 而不是 REPLACE，否则 `shopwww.com` 这种会被从中间削掉。
    // ── ③ 同品牌不同后缀：`acmejoy.com` 判了成人，`acmejoy.nl`/`.it`/`.fr` 是同一个品牌 ──
    //
    // 07 拍板（2026-08-07）只对四类硬禁品类扩展、且品牌名 ≥ 6 字。两条限制都是必要的：
    // 品类不限的话，金融/保险里 `travel`、`shop` 这种通用首段会把无关商家一起判死；
    // 长度不限的话 `cbd.com` 的首段 `cbd` 会命中一切以 cbd 开头的域名。
    // 只认 `blocked`——`review` 是待复核，还没定性，没有理由让它扩散到别的域名去。
    const byBrand = new Map<string, Verdict>();
    if (expandDomain) {
      for (const v of list) {
        if (v.verdict !== "blocked") continue;
        const code = String(v.policy_code || "");
        if (!EXPAND_CODES.has(code)) continue;
        const brand = String(v.domain || "").trim().toLowerCase().split(".")[0];
        if (brand.length < 6) continue;
        if (!byBrand.has(brand)) byBrand.set(brand, v);
      }
    }

    let matchedByDomain = 0;
    let matchedByBrand = 0;
    const brandSkipped: Array<{ brand: string; domains: number }> = [];
    if (expandDomain && byDomain.size) {
      const domains = [...byDomain.keys()];
      const brands = [...byBrand.keys()];
      const domPh = domains.map(() => "?").join(",");
      // 品牌集合可能为空，为空时给一个不可能命中的占位，免得拼出 `IN ()` 语法错
      const brandPh = brands.length ? brands.map(() => "?").join(",") : "?";
      const cand = await prisma.$queryRawUnsafe<Array<{
        id: bigint; platform: string; merchant_id: string; merchant_url: string | null;
        category: string | null; category_manual: number; policy_status: string | null;
        policy_category_code: string | null; dom: string; brand: string;
      }>>(
        `SELECT id, platform, merchant_id, merchant_url, category, category_manual,
                policy_status, policy_category_code,
                LOWER(TRIM(LEADING 'www.' FROM
                  SUBSTRING_INDEX(SUBSTRING_INDEX(
                    REPLACE(REPLACE(merchant_url, 'https://', ''), 'http://', ''), '/', 1), '?', 1))) AS dom,
                SUBSTRING_INDEX(LOWER(TRIM(LEADING 'www.' FROM
                  SUBSTRING_INDEX(SUBSTRING_INDEX(
                    REPLACE(REPLACE(merchant_url, 'https://', ''), 'http://', ''), '/', 1), '?', 1))), '.', 1) AS brand
           FROM user_merchants
          WHERE is_deleted = 0 AND merchant_url IS NOT NULL
         HAVING dom IN (${domPh}) OR brand IN (${brandPh})`,
        ...domains,
        ...(brands.length ? brands : ["\u0000"]),
      );

      // 品牌命中先按品牌归堆：一个 6 字以上的词仍可能是通用词（如某国语言里的常见词），
      // 命中域名数异常多就不写，只报出来让人看，别静默把一片无关商家判死
      const BRAND_MAX_DOMAINS = 20;
      const brandHits = new Map<string, typeof cand>();
      const exactHits: typeof cand = [];
      const seen = new Set(rows.map((r) => String(r.id)));
      for (const c of cand) {
        if (seen.has(String(c.id))) continue;
        const dom = String(c.dom || "").toLowerCase();
        if (byDomain.has(dom)) { exactHits.push(c); continue; }
        const brand = String(c.brand || "").toLowerCase();
        if (!byBrand.has(brand)) continue;
        if (!brandHits.has(brand)) brandHits.set(brand, []);
        brandHits.get(brand)!.push(c);
      }

      for (const c of exactHits) {
        const v = byDomain.get(String(c.dom).toLowerCase())!;
        matchedByDomain++;
        planRow({
          id: c.id, category: c.category,
          category_manual: Number(c.category_manual || 0), policy_status: c.policy_status,
        }, v);
      }

      for (const [brand, hits] of brandHits) {
        const domainCount = new Set(hits.map((h) => String(h.dom))).size;
        if (domainCount > BRAND_MAX_DOMAINS) {
          brandSkipped.push({ brand, domains: domainCount });
          continue;
        }
        const v = byBrand.get(brand)!;
        for (const c of hits) {
          matchedByBrand++;
          planRow({
            id: c.id, category: c.category,
            category_manual: Number(c.category_manual || 0), policy_status: c.policy_status,
          }, v);
        }
      }
    }

    if (dryRun) {
      const preview = [...plans.entries()].slice(0, 10).map(([id, p]) => ({
        row_id: id, category: p.category ?? null,
        policy_status: p.policy_status ?? null, policy_category_code: p.policy_category_code ?? null,
        domain: p.v.domain ?? null, verdict: p.v.verdict,
      }));
      return apiSuccess({
        dry_run: true,
        verdicts_in: list.length,
        matched_rows: matchedByMid + matchedByDomain + matchedByBrand,
        matched_by_brand: matchedByBrand,
        brand_expand_codes: [...byBrand.keys()].length,
        brand_skipped: brandSkipped,
        would_write: plans.size,
        category_writes: [...plans.values()].filter((p) => p.category !== undefined).length,
        policy_writes: [...plans.values()].filter((p) => p.policy_status !== undefined).length,
        skipped_manual: skippedManual,
        unknown_codes: [...unknownCodes],
        preview,
      }, `干跑：命中 ${matchedByMid + matchedByDomain + matchedByBrand} 行，会写 ${plans.size} 行`);
    }

    // ── ③ 落库：按「写什么」分组批量 updateMany，避免逐行 update ──
    const groups = new Map<string, { ids: bigint[]; data: Record<string, unknown> }>();
    for (const [id, p] of plans) {
      const data: Record<string, unknown> = {};
      if (p.category !== undefined) { data.category = p.category; data.category_manual = 1; }
      if (p.policy_status !== undefined) data.policy_status = p.policy_status;
      if (p.policy_category_code !== undefined) data.policy_category_code = p.policy_category_code;
      const sig = JSON.stringify(data);
      if (!groups.has(sig)) groups.set(sig, { ids: [], data });
      groups.get(sig)!.ids.push(BigInt(id));
    }

    let written = 0;
    for (const g of groups.values()) {
      // 单条 IN 列表别太长，MySQL 的 max_allowed_packet 和执行计划都会难看
      for (let i = 0; i < g.ids.length; i += 500) {
        const res = await prisma.user_merchants.updateMany({
          where: { id: { in: g.ids.slice(i, i + 500) } },
          data: g.data,
        });
        written += res.count;
      }
    }

    // ── ④ 审核留痕：谁判的、凭什么判的，写进 merchant_policy_reviews ──
    let audited = 0;
    const catIdByCode = new Map(
      (await prisma.ad_policy_categories.findMany({
        where: { is_deleted: 0 }, select: { id: true, category_code: true },
      })).map((c) => [c.category_code, c.id]),
    );
    for (const v of list) {
      const name = String(v.merchant_name || "").trim();
      if (!name) continue;
      const st = STATUS_OF[String(v.verdict || "")] || (v.verdict === "cleared" && v.layer === "manual" ? "clean" : null);
      if (!st) continue;
      const platform = String(v.network || "").toUpperCase().slice(0, 8);
      const code = String(v.policy_code || "");
      try {
        await prisma.merchant_policy_reviews.upsert({
          where: { merchant_name_platform: { merchant_name: name.slice(0, 255), platform } },
          create: {
            merchant_name: name.slice(0, 255),
            merchant_domain: String(v.domain || "").slice(0, 255) || null,
            platform,
            policy_category_id: catIdByCode.get(code) ?? null,
            policy_status: st,
            matched_rule: `hermes:${v.layer || "unknown"}`.slice(0, 128),
            review_method: "hermes",
            notes: String(v.evidence || "").slice(0, 2000) || null,
            reviewed_at: new Date(),
          },
          update: {
            merchant_domain: String(v.domain || "").slice(0, 255) || null,
            policy_category_id: catIdByCode.get(code) ?? null,
            policy_status: st,
            matched_rule: `hermes:${v.layer || "unknown"}`.slice(0, 128),
            review_method: "hermes",
            notes: String(v.evidence || "").slice(0, 2000) || null,
            reviewed_at: new Date(),
          },
        });
        audited++;
      } catch {
        // 留痕失败不该影响主写入（唯一键是 merchant_name+platform，重名商家会撞）
      }
    }

    const categoryWrites = [...plans.values()].filter((p) => p.category !== undefined).length;
    const policyWrites = [...plans.values()].filter((p) => p.policy_status !== undefined).length;
    console.log(
      `[HermesPolicy] 收到 ${list.length} 条判定，命中 ${matchedByMid + matchedByDomain + matchedByBrand} 行` +
      `（MID ${matchedByMid} / 域名 ${matchedByDomain} / 同品牌异后缀 ${matchedByBrand}），写 ${written} 行` +
      `｜主营业务 ${categoryWrites}、政策标记 ${policyWrites}、跳过人工修正 ${skippedManual}` +
      `｜留痕 ${audited}${unknownCodes.size ? `｜未知品类代码 ${[...unknownCodes].join(",")}` : ""}` +
      `${brandSkipped.length ? `｜品牌名疑似通用词未扩展 ${brandSkipped.map((b) => `${b.brand}(${b.domains}域名)`).join(",")}` : ""}`,
    );

    return apiSuccess({
      verdicts_in: list.length,
      matched_rows: matchedByMid + matchedByDomain + matchedByBrand,
      matched_by_mid: matchedByMid,
      matched_by_domain: matchedByDomain,
      matched_by_brand: matchedByBrand,
      brand_skipped: brandSkipped,
      written,
      category_writes: categoryWrites,
      policy_writes: policyWrites,
      skipped_manual: skippedManual,
      audited,
      unknown_codes: [...unknownCodes],
    }, `已回写 ${written} 行（主营业务 ${categoryWrites}、政策标记 ${policyWrites}）`);
  } catch (err) {
    console.error("[HermesPolicy] POST 异常:", err);
    return apiError("回写禁投品类判定失败", 500);
  }
}
