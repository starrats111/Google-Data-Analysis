/**
 * 「最终到达网址后缀」（Google Ads campaign.final_url_suffix）的统一口径。
 *
 * D-365：此前这套清洗规则在四处各写一遍，口径靠人工对齐：
 *   - generate-extensions/route.ts:781（D-101 巡航回填，只 replace 前导 ?&）
 *   - update-final-url/route.ts:92（员工手填保存，剥前导 + 去尾部 &）
 *   - submit/route.ts:1262（提交上传前归一）
 *   - mutate.ts（D-365 新增的改后缀 updater）
 * 本模块把「从巡航/缓存得到的 query 串 → 可入库可上传的后缀」收敛成一个函数，
 * 任何新的回填点都应调它，不要再各自 replace。
 *
 * 口径三条，缺一不可：
 *   1. D-234：过参数黑名单（剔 referer= / url=<URL>），否则脏参数绕过 resolver 直接落库，
 *      展示网址与到达网址不一致，真实投放过 1985 次。
 *   2. D-157：剥前导 '?'/'&'（Google Ads 拒绝以其开头，报 INVALID_ARGUMENT）+ 去尾部多余 &。
 *   3. D-354：整条追踪链接当后缀会在 Google 端拼出「落地页?https://…」的废到达页，
 *      宁可不带后缀；但参数值里含 URL（utm_campaign=https://…）是合法的，必须原样保留。
 */
import { sanitizeTrackingQuery, looksLikeWholeTrackingLink } from "./affiliate-link-resolver";

/** campaigns.final_url_suffix 是 VARCHAR(500) */
export const FINAL_URL_SUFFIX_MAX = 500;

/**
 * 把巡航得到的 query 串规整成可入库/可上传的后缀。
 * 不可用（空串、纯脏参数、整条链接）一律返回 null —— 调用方据此跳过回填。
 */
export function normalizeSuffixForBackfill(rawQuery: string | null | undefined): string | null {
  const cleaned = (sanitizeTrackingQuery(rawQuery) || "")
    .replace(/^[?&\s]+/, "")
    .replace(/[?&\s]+$/, "")
    .trim();
  if (!cleaned) return null;
  if (looksLikeWholeTrackingLink(cleaned)) return null;
  return cleaned.slice(0, FINAL_URL_SUFFIX_MAX);
}

/**
 * 判断「当前是否已有后缀」。有则不回填 —— 不覆盖员工手填值，
 * 与 generate-extensions:777 的既有口径一致。
 */
export function hasExistingSuffix(
  bodySuffix: string | null | undefined,
  dbSuffix: string | null | undefined,
): boolean {
  // ⚠️ 不能写成 `bodySuffix ?? dbSuffix`：`??` 只挡 null/undefined，前端传空串时会短路掉库值，
  //    于是明明库里有员工手填的后缀，却被判成「未设置」→ 巡航回填把它覆盖掉。
  //    与 submit 读取侧同一口径（route.ts:1258 的 `(a ?? b ?? undefined) || undefined`
  //    尾部那个 `||` 正是干这件事）：空白一律视为没有，再看下一个来源。
  const body = (bodySuffix || "").trim();
  if (body) return true;
  return !!(dbSuffix || "").trim();
}
