/**
 * 2026-07-13（第五轮）：统一 HTTP 响应体解码。
 *
 * 病灶：全链路 `res.text()` / `buf.toString("utf8")` 假定 UTF-8，
 * 没有任何地方读 Content-Type 的 charset= 或 <meta charset>。
 * 日本老站（Shift_JIS/EUC-JP）、GBK/GB2312、欧洲 windows-1252/ISO-8859-1
 * 页面的 pageText/features/rawMentions 全部乱码入库，AI 对着乱码生成文案。
 *
 * 解码优先级（与浏览器一致）：
 *   1. Content-Type 头的 charset=
 *   2. HTML 前 4KB 的 <meta charset> / <meta http-equiv="Content-Type">
 *   3. UTF-8 试解码，替换字符（U+FFFD）比例过高时回退 windows-1252
 */
import iconv from "iconv-lite";

/** charset 别名归一化（iconv-lite 认识大部分，但常见笔误/旧名先规整） */
function normalizeCharset(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/['"]/g, "");
  if (!s) return "";
  const ALIAS: Record<string, string> = {
    "utf8": "utf-8",
    "iso-8859-1": "windows-1252", // 浏览器惯例：latin1 按 win-1252 解（含 €/™ 等）
    "latin1": "windows-1252",
    "ascii": "windows-1252",
    "us-ascii": "windows-1252",
    "gb2312": "gbk", // gb2312 是 gbk 子集，按 gbk 解更稳
    "x-sjis": "shift_jis",
    "sjis": "shift_jis",
  };
  return ALIAS[s] ?? s;
}

/** 从 Content-Type 头提取 charset */
export function charsetFromContentType(contentType: string | null | undefined): string {
  if (!contentType) return "";
  const m = /charset\s*=\s*([^;,\s]+)/i.exec(contentType);
  return m ? normalizeCharset(m[1]) : "";
}

/** 从 HTML 前 4KB 嗅探 <meta charset>（先按 latin1 粗解字节，meta 声明必为 ASCII 安全） */
export function charsetFromHtmlMeta(buf: Buffer): string {
  const head = buf.subarray(0, 4096).toString("latin1");
  const m1 = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
  if (m1) return normalizeCharset(m1[1]);
  const m2 = /<meta[^>]+http-equiv\s*=\s*["']content-type["'][^>]*content\s*=\s*["'][^"']*charset=([\w-]+)/i.exec(head);
  if (m2) return normalizeCharset(m2[1]);
  return "";
}

/** U+FFFD（替换字符）占比，用于判定 UTF-8 解码是否失败 */
function replacementRatio(s: string): number {
  if (!s) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0xfffd) n++;
  return n / s.length;
}

/**
 * 字节 → 文本，按声明的 charset 解码；无声明/解码失败时 UTF-8 优先、win-1252 兜底。
 */
export function decodeHtmlBuffer(buf: Buffer, contentType?: string | null): string {
  if (!buf || buf.length === 0) return "";
  // BOM 直接定調
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8");
  }
  const declared = charsetFromContentType(contentType) || charsetFromHtmlMeta(buf);
  if (declared && declared !== "utf-8") {
    try {
      if (iconv.encodingExists(declared)) return iconv.decode(buf, declared);
    } catch { /* 落到 UTF-8 路径 */ }
  }
  const utf8 = buf.toString("utf8");
  // 无声明或声明 utf-8 但实际不是：替换字符 >2% 视为解码失败，按 win-1252 重解
  // （欧洲未声明编码的老站几乎都是 win-1252；CJK 无声明场景极罕见，不启发式猜）
  if (replacementRatio(utf8) > 0.02) {
    try { return iconv.decode(buf, "windows-1252"); } catch { /* ignore */ }
  }
  return utf8;
}

/**
 * fetch Response → 正确解码的文本（drop-in 替代 res.text()）。
 * 注意：全局 fetch 的 res.text() 内部固定 UTF-8，必须走 arrayBuffer 拿原始字节。
 */
export async function decodeResponseText(res: Response): Promise<string> {
  const buf = Buffer.from(await res.arrayBuffer());
  return decodeHtmlBuffer(buf, res.headers.get("content-type"));
}
