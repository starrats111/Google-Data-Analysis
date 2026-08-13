/**
 * 兼容 legacy `string[]` 与新对象数组 shape 的 read-side normalizer。
 * - 接受任意 JSON.parse 输出（unknown），安全返回强类型数组。
 * - 空 text / 空 linkText / 空 finalUrl 被静默丢弃。
 * - 缺失元数据按 spec §6.3 填默认值；`charLen` 若缺失则按 Google Ads 双宽规则重算；
 *   若入参显式提供 `charLen`，会被原样保留（不重算），调用方需保证写入时使用了 googleAdsLength。
 * - 非字符串 `text` 会被 `String(v)` 救回（不强制 drop），调用方应避免写入非字符串。
 * - 无 node-only 依赖，client/server 通用。
 */
import { googleAdsLength } from "./text-length";

export interface HeadlineItem {
  text: string;
  score: number;
  type: string;
  charLen: number;
  isOwn: boolean;
  pinPosition?: 1 | 2 | 3;
}

export interface DescriptionItem {
  text: string;
  score: number;
  charLen: number;
  isOwn: boolean;
}

export interface SitelinkItem {
  linkText: string;
  finalUrl: string;
  description1?: string;
  description2?: string;
  score: number;
  angle: string;
  isOwn: boolean;
}

function toNumber(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toStr(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

export function normalizeHeadlines(raw: unknown): HeadlineItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): HeadlineItem | null => {
      if (typeof item === "string") {
        const text = item.trim();
        if (!text) return null;
        return { text, score: 0, type: "unknown", charLen: googleAdsLength(text), isOwn: false };
      }
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        const text = toStr(obj.text).trim();
        if (!text) return null;
        const pin = obj.pinPosition;
        const pinPosition = pin === 1 || pin === 2 || pin === 3 ? (pin as 1 | 2 | 3) : undefined;
        return {
          text,
          score: toNumber(obj.score, 0),
          type: toStr(obj.type) || "unknown",
          charLen: toNumber(obj.charLen, googleAdsLength(text)),
          isOwn: obj.isOwn === true,
          pinPosition,
        };
      }
      return null;
    })
    .filter((x): x is HeadlineItem => x !== null);
}

export function normalizeDescriptions(raw: unknown): DescriptionItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): DescriptionItem | null => {
      if (typeof item === "string") {
        const text = item.trim();
        if (!text) return null;
        return { text, score: 0, charLen: googleAdsLength(text), isOwn: false };
      }
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        const text = toStr(obj.text).trim();
        if (!text) return null;
        return {
          text,
          score: toNumber(obj.score, 0),
          charLen: toNumber(obj.charLen, googleAdsLength(text)),
          isOwn: obj.isOwn === true,
        };
      }
      return null;
    })
    .filter((x): x is DescriptionItem => x !== null);
}

export function normalizeSitelinks(raw: unknown): SitelinkItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): SitelinkItem | null => {
      if (!item || typeof item !== "object") return null;
      const obj = item as Record<string, unknown>;
      const linkText = toStr(obj.linkText).trim();
      const finalUrl = toStr(obj.finalUrl).trim();
      if (!linkText || !finalUrl) return null;
      const description1 = toStr(obj.description1).trim() || undefined;
      const description2 = toStr(obj.description2).trim() || undefined;
      return {
        linkText,
        finalUrl,
        description1,
        description2,
        score: toNumber(obj.score, 0),
        angle: toStr(obj.angle) || "unknown",
        isOwn: obj.isOwn === true,
      };
    })
    .filter((x): x is SitelinkItem => x !== null);
}

export function extractHeadlineTexts(raw: unknown): string[] {
  return normalizeHeadlines(raw).map((h) => h.text);
}

export function extractDescriptionTexts(raw: unknown): string[] {
  return normalizeDescriptions(raw).map((d) => d.text);
}
