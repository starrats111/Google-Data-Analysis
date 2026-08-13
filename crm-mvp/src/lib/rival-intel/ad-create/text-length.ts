/**
 * Google Ads 素材字符长度计算工具。
 *
 * 背景：Google Ads 后台对 RSA 标题/描述、站内链接标题/描述等字段的长度判定
 * 采用"双宽字符（CJK 中日韩、全角符号、表情等）算 2 个字符"的规则，而
 * JavaScript 原生 `String.prototype.length` 按 UTF-16 code unit 计数，对
 * BMP 内 CJK 字符仅算 1，从而导致"JS 里 26 字符"的韩文标题在 Google 判
 * 定为 34 字符，触发 "Too long"。本文件提供与 Google Ads 对齐的长度计算
 * 与截断函数。
 *
 * 判定范围覆盖主流 CJK 与全角区间（EAW=F/W 的常用子集）；不覆盖需要处理
 * 组合字符/ZWJ emoji 的复杂场景，对广告文案够用。
 */

function isDoubleWidthCodePoint(cp: number): boolean {
  return (
    // Hangul Jamo
    (cp >= 0x1100 && cp <= 0x115f) ||
    // Hangul Jamo Extended-A
    (cp >= 0xa960 && cp <= 0xa97f) ||
    // Hangul Syllables
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    // Hangul Compatibility Jamo
    (cp >= 0x3130 && cp <= 0x318f) ||
    // Hangul Jamo Extended-B
    (cp >= 0xd7b0 && cp <= 0xd7ff) ||
    // CJK Radicals Supplement, Kangxi Radicals
    (cp >= 0x2e80 && cp <= 0x2fff) ||
    // CJK Symbols and Punctuation, Hiragana, Katakana, Bopomofo, Hangul Compat. etc.
    (cp >= 0x3000 && cp <= 0x33ff) ||
    // CJK Unified Ideographs Extension A
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    // CJK Unified Ideographs
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    // Yi Syllables / Radicals
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    // CJK Compatibility Ideographs
    (cp >= 0xf900 && cp <= 0xfaff) ||
    // CJK Compatibility Forms & Small Form Variants
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    // Fullwidth Forms (ASCII 全角、全角标点)
    (cp >= 0xff00 && cp <= 0xff60) ||
    // Fullwidth Signs
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    // CJK Unified Ideographs Extension B-F (supplementary plane)
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    // CJK Unified Ideographs Extension G-H
    (cp >= 0x30000 && cp <= 0x3fffd)
  );
}

/**
 * 返回文本在 Google Ads 计算规则下的"字符单位数"。
 *
 * - 双宽字符（CJK、全角）：2
 * - 其余（ASCII、拉丁字母、普通数字/标点、半角假名等）：1
 */
export function googleAdsLength(text: string): number {
  if (!text) return 0;
  let len = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    len += isDoubleWidthCodePoint(cp) ? 2 : 1;
  }
  return len;
}

/**
 * 按 Google Ads 规则将文本截断到不超过 `maxUnits` 单位。若 `preferWordBoundary`
 * 为 true 且截断后的空格位置保留了至少 70% 的额度，则在最后一个空格处切断。
 */
export function truncateToGoogleAdsLength(
  text: string,
  maxUnits: number,
  preferWordBoundary = false,
): string {
  if (!text) return "";
  if (googleAdsLength(text) <= maxUnits) return text;

  let acc = "";
  let len = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const w = isDoubleWidthCodePoint(cp) ? 2 : 1;
    if (len + w > maxUnits) break;
    acc += ch;
    len += w;
  }

  if (preferWordBoundary) {
    const lastSpace = acc.lastIndexOf(" ");
    if (lastSpace >= 0 && googleAdsLength(acc.slice(0, lastSpace)) >= maxUnits * 0.7) {
      return acc.slice(0, lastSpace);
    }
  }
  return acc;
}

export {
  sanitizeGoogleAdsRsaText,
  containsGoogleAdsProhibitedSymbols,
} from "./google-ads-editorial-policy";
