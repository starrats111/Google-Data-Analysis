/**
 * D-370：omniluxe.top「首页又没内容了」—— 不是白屏，是 TypeError。
 *
 * 该站数据和渲染器同住 assets/app.js（const posts = [...] 后面接渲染器）。
 * 原模板的条目字段是 categories（数组）+ articleUrl + displayDate；CRM 的
 * publishArticleToSite 在修这个 bug 之前，往这个数组插入新文章时直接用标准
 * 字段（category 字符串 + detailUrl + dateLabel），从未按该站原有条目的
 * 字段风格适配。两种条目混进同一个数组，旧条目渲染正常，新条目一进
 * renderPosts() 跑到 `post.categories.join(" · ")` 就因 categories 是
 * undefined 直接抛 TypeError，整个渲染函数中断，#postGrid 保持空。
 *
 * publishArticleToSite 那边已经改成用 adaptEntryToHomepageSchema 适配新插入
 * 的条目（往后不会再混进这种脏数据），但线上已经有的那批脏条目需要一次性
 * 纠正——这不是常规的"数据文件损坏"（repairSiteDataFile 对非 A1、无渲染器
 * 截断的文件不会碰它，这个文件语法完好、渲染器完好，走不到那条修复路径），
 * 所以单独写这个一次性转换，而不是接进日常巡检管线。
 */
import JSON5 from "json5";

/** 单条数据条目在 omniluxe.top 的两种并存形态 */
interface CrmStyleEntry {
  id?: string;
  slug?: string;
  title?: string;
  category?: string;
  date?: string;
  dateISO?: string;
  dateLabel?: string;
  readTime?: string;
  excerpt?: string;
  image?: string;
  heroImage?: string;
  detailUrl?: string;
  tags?: string[];
  [key: string]: unknown;
}

const HOMEPAGE_CATEGORY_LABELS: Record<string, string> = {
  fashion: "Fashion & Accessories",
  health: "Health & Beauty",
  home: "Home & Garden",
  travel: "Travel & Accommodation",
  finance: "Finance & Insurance",
  food: "Food & Beverage",
};

function labelOfCategory(cat: string): string {
  const key = cat.toLowerCase();
  return HOMEPAGE_CATEGORY_LABELS[key] || (key.charAt(0).toUpperCase() + key.slice(1));
}

/** 是否已经是该站原模板的 categories 数组形态 —— 用来判断"不用转换" */
function isNativeSchema(entry: CrmStyleEntry): boolean {
  return Array.isArray(entry.categories) && typeof entry.articleUrl === "string";
}

/** 是否是 CRM 标准字段形态 —— 需要被转换的脏数据 */
function isCrmSchema(entry: CrmStyleEntry): boolean {
  return typeof entry.category === "string" && typeof entry.detailUrl === "string";
}

function toNativeSchema(entry: CrmStyleEntry): Record<string, unknown> {
  const detailUrl = String(entry.detailUrl || "");
  return {
    slug: entry.slug,
    title: entry.title,
    categories: [labelOfCategory(String(entry.category || "general"))],
    date: entry.dateISO || entry.date,
    displayDate: entry.dateLabel || entry.date,
    excerpt: entry.excerpt,
    image: entry.heroImage || entry.image,
    articleUrl: `/${detailUrl.replace(/^\/+|\/+$/g, "")}/`,
  };
}

export interface FixOmniluxeFieldMismatchResult {
  patched: string | null;
  fixedCount: number;
}

/** 从 `const posts = [` 的 `[` 开始找配对的 `]`（与 remote-publisher.ts 里的做法一致：逐字符数括号，跳过字符串内容） */
function findArrayBounds(content: string, openBracketIndex: number): number | null {
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  for (let i = openBracketIndex; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (ch === "\\") { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/**
 * 把 scriptJs（const posts = [...] + 渲染器）里混进去的 CRM 标准字段条目
 * 转换成该站原模板的 categories 数组形态。不动已经是原生形态的条目，
 * 也不碰渲染器部分——只替换 `const posts = [...]` 这个数组字面量本身。
 *
 * 返回 patched: null 表示没找到 `const posts = [...]` 声明，或数组解析失败
 * （文件已被换成别的版本），调用方据此判断是否已经处理过或者文件形态变了。
 */
export function fixOmniluxeFieldMismatch(scriptJs: string): FixOmniluxeFieldMismatchResult {
  const declRe = /const\s+posts\s*=\s*\[/;
  const declMatch = declRe.exec(scriptJs);
  if (!declMatch || declMatch.index === undefined) return { patched: null, fixedCount: 0 };

  const openBracket = declMatch.index + declMatch[0].length - 1;
  const closeBracket = findArrayBounds(scriptJs, openBracket);
  if (closeBracket === null) return { patched: null, fixedCount: 0 };

  const slice = scriptJs.slice(openBracket, closeBracket + 1);
  let entries: CrmStyleEntry[];
  try {
    const parsed = JSON5.parse(slice) as unknown;
    if (!Array.isArray(parsed)) return { patched: null, fixedCount: 0 };
    entries = parsed as CrmStyleEntry[];
  } catch {
    return { patched: null, fixedCount: 0 };
  }

  let fixedCount = 0;
  const converted = entries.map((entry) => {
    if (isNativeSchema(entry)) return entry;
    if (isCrmSchema(entry)) {
      fixedCount += 1;
      return toNativeSchema(entry);
    }
    return entry;
  });

  if (fixedCount === 0) return { patched: null, fixedCount: 0 };

  const serialized = JSON.stringify(converted, null, 2);
  const patched = scriptJs.slice(0, openBracket) + serialized + scriptJs.slice(closeBracket + 1);
  return { patched, fixedCount };
}
