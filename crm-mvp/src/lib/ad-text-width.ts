/**
 * 2026-07-13（第六轮）P0：Google Ads 显示宽度计数。
 *
 * Google Ads 的字符限制按「显示宽度」计：CJK / 全角字符算 2 个单位，半角算 1。
 * 全链路此前一律用 string.length（UTF-16 码元数）——
 *   ① 日语标题「最高のランニングシューズ」length=11 看似合格，Google 按宽度 22 计，
 *     真实上限 30 内没问题，但 15 个 CJK 字符（length=15，宽度 30）再加任何标点必超；
 *   ② emoji（代理对）length=2 但宽度按 2 计也不一致；slice 还会把代理对切成半个乱码。
 * 系统性后果：CJK 市场（日/韩/中/泰）本地校验全绿、Google mutate 整批拒绝。
 *
 * 本模块提供：
 *   - googleAdsTextWidth(s)：按码点遍历，宽字符计 2、窄字符计 1；
 *   - truncateByWidth(s, maxWidth)：码点安全（绝不切半个代理对）、宽度感知截断，
 *     有空格的语言回退到词边界，尾部标点清理与 smartTruncate 口径一致。
 */

/** 判断单个码点是否为「宽字符」（CJK / 全角 / 韩文 / 假名等，Google Ads 计 2 单位） */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals / Kangxi / CJK 符号标点
    (cp >= 0x3041 && cp <= 0x33ff) || // 平假名/片假名/注音/兼容 CJK
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 韩文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII / 全角标点
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角货币符号
    (cp >= 0x20000 && cp <= 0x2fffd) || // CJK 扩展 B-F
    (cp >= 0x30000 && cp <= 0x3fffd) || // CJK 扩展 G
    (cp >= 0x1f300 && cp <= 0x1faff)   // emoji（按宽字符保守计 2）
  );
}

/** Google Ads 显示宽度：宽字符 2 单位、其余 1 单位（按码点遍历，代理对不重复计） */
export function googleAdsTextWidth(s: string | null | undefined): number {
  if (!s) return 0;
  let width = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    width += isWideCodePoint(cp) ? 2 : 1;
  }
  return width;
}

/**
 * 宽度感知 + 码点安全截断：
 *   - 按码点累计宽度，超出 maxWidth 前停下（绝不切半个代理对/emoji）；
 *   - 文本含空格（有分词语言）且词边界在 50% 以后 → 回退到最后一个完整词；
 *   - CJK 等无空格语言直接按宽度截（字符本身即语义单元，无「半截词」问题）；
 *   - 清理尾部悬挂标点。
 */
export function truncateByWidth(text: string, maxWidth: number): string {
  const t = (text ?? "").trim();
  if (googleAdsTextWidth(t) <= maxWidth) return t;

  let width = 0;
  let out = "";
  for (const ch of t) {
    const w = isWideCodePoint(ch.codePointAt(0)!) ? 2 : 1;
    if (width + w > maxWidth) break;
    width += w;
    out += ch;
  }

  const lastSpace = out.lastIndexOf(" ");
  if (lastSpace > 0 && googleAdsTextWidth(out.slice(0, lastSpace)) > maxWidth * 0.5) {
    out = out.slice(0, lastSpace);
  }
  return out.replace(/[,.\-\u2013\u2014:;、。，．・\s]+$/u, "").trim();
}
