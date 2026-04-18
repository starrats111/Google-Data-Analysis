const IMAGE_TAG_REGEX = /<img\s[^>]*?(?:src|data-src)=["'][^"']+["'][^>]*?\/?>/gi;
const BLOCK_TAG_REGEX = /(<(?:h[1-6]|p|div|ul|ol|blockquote|table|figure|section)[\s>][\s\S]*?<\/(?:h[1-6]|p|div|ul|ol|blockquote|table|figure|section)>)/gi;
const TOKEN_REGEX = /(<img\s[^>]*?(?:src|data-src)=["'][^"']+["'][^>]*?\/?> |<(?:h[1-6]|p|div|ul|ol|blockquote|table|figure|section)[\s>][\s\S]*?<\/(?:h[1-6]|p|div|ul|ol|blockquote|table|figure|section)>)/gi;

export interface ArticleImageLayoutItem {
  url: string;
  position: number;
}

export function normalizeArticleImageList(images: unknown): string[] {
  if (!Array.isArray(images)) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of images) {
    if (typeof item !== "string") continue;
    const url = item.trim();
    if (!url) continue;
    if (!isSupportedArticleImageUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }

  return result;
}

export function isSupportedArticleImageUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
    || /^\/api\/user\/ad-creation\/upload-image\//i.test(url)
    || /^\/images\//i.test(url)
    || /^\.?\/?images\//i.test(url);
}

export function stripArticleImages(content: string): string {
  if (!content) return "";
  return content.replace(IMAGE_TAG_REGEX, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function collectArticleBlocks(content: string): string[] {
  if (!content) return [];
  return content.match(BLOCK_TAG_REGEX) || [];
}

export function collectArticleImagePositionOptions(content: string): Array<{ value: number; label: string }> {
  const blocks = collectArticleBlocks(stripArticleImages(content));
  const options: Array<{ value: number; label: string }> = [
    { value: 0, label: "文章开头（标题后 / 封面图）" },
  ];

  blocks.forEach((block, index) => {
    const text = block.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const snippet = text ? text.slice(0, 24) : `第 ${index + 1} 段`;
    options.push({ value: index + 1, label: `${index + 1}. ${snippet}` });
  });

  return options;
}

export function buildDefaultArticleImageLayout(content: string, images: string[]): ArticleImageLayoutItem[] {
  const normalizedImages = normalizeArticleImageList(images);
  if (normalizedImages.length === 0) return [];

  const options = collectArticleImagePositionOptions(content)
    .map((option) => option.value)
    .filter((value) => value > 0);

  const fallbackBlockCount = Math.max(collectArticleBlocks(stripArticleImages(content)).length, 1);
  const usableOptions = options.length > 0
    ? options
    : Array.from({ length: fallbackBlockCount }, (_, index) => index + 1);

  const layout: ArticleImageLayoutItem[] = [
    { url: normalizedImages[0], position: 0 },
  ];

  const bodyImages = normalizedImages.slice(1);
  if (bodyImages.length === 0) {
    return layout;
  }

  bodyImages.forEach((url, index) => {
    const optionIndex = Math.max(0, Math.ceil(((index + 1) * usableOptions.length) / (bodyImages.length + 1)) - 1);
    layout.push({
      url,
      position: usableOptions[optionIndex] ?? usableOptions[usableOptions.length - 1] ?? 1,
    });
  });

  return normalizeArticleImageLayout(layout);
}

export function inferArticleImageLayout(content: string, images: string[]): ArticleImageLayoutItem[] {
  const normalizedImages = normalizeArticleImageList(images);
  if (normalizedImages.length === 0) return [];
  if (!content) return buildDefaultArticleImageLayout(content, normalizedImages);

  const tokens = content.match(TOKEN_REGEX) || [];
  const matched = new Set<string>();
  const inferred: ArticleImageLayoutItem[] = [];
  let blockCount = 0;

  for (const token of tokens) {
    if (/^<img\b/i.test(token)) {
      const srcMatch = token.match(/(?:src|data-src)=["']([^"']+)["']/i);
      const src = srcMatch?.[1]?.trim();
      if (!src) continue;

      const matchedUrl = normalizedImages.find((imageUrl) => !matched.has(imageUrl) && isSameImageSource(imageUrl, src));
      if (!matchedUrl) continue;

      matched.add(matchedUrl);
      inferred.push({ url: matchedUrl, position: blockCount });
      continue;
    }

    blockCount += 1;
  }

  const missingImages = normalizedImages.filter((url) => !matched.has(url));
  if (inferred.length === 0) {
    return buildDefaultArticleImageLayout(content, normalizedImages);
  }

  if (missingImages.length > 0) {
    const fallback = buildDefaultArticleImageLayout(content, missingImages);
    inferred.push(...fallback);
  }

  return normalizeArticleImageLayout(inferred);
}

export function normalizeArticleImageLayout(layout: ArticleImageLayoutItem[]): ArticleImageLayoutItem[] {
  const seen = new Set<string>();
  const normalized = layout
    .filter((item) => item && typeof item.url === "string")
    .map((item) => ({
      url: item.url.trim(),
      position: Number.isFinite(item.position) ? Math.max(0, Math.floor(item.position)) : 0,
    }))
    .filter((item) => item.url.length > 0 && isSupportedArticleImageUrl(item.url))
    .filter((item) => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    });

  if (normalized.length === 0) return [];

  normalized[0].position = 0;
  for (let i = 1; i < normalized.length; i += 1) {
    if (normalized[i].position === 0) {
      normalized[i].position = 1;
    }
  }

  return normalized;
}

export function rebuildArticleContentWithLayout(content: string, layout: ArticleImageLayoutItem[], title: string): string {
  const baseContent = stripArticleImages(content);
  const normalizedLayout = normalizeArticleImageLayout(layout);
  if (!baseContent) {
    return normalizedLayout
      .map((item, index) => buildArticleImageTag(item.url, title, index === 0, index + 1))
      .join("\n");
  }

  if (normalizedLayout.length === 0) {
    return baseContent;
  }

  const blocks = collectArticleBlocks(baseContent);
  if (blocks.length === 0) {
    return [
      ...normalizedLayout.map((item, index) => buildArticleImageTag(item.url, title, index === 0, index + 1)),
      baseContent,
    ].join("\n");
  }

  const insertMap = new Map<number, string[]>();
  normalizedLayout.forEach((item, index) => {
    const entry = insertMap.get(item.position) || [];
    entry.push(buildArticleImageTag(item.url, title, index === 0, index + 1));
    insertMap.set(item.position, entry);
  });

  const firstBlockIndex = baseContent.indexOf(blocks[0]);
  let cursor = 0;
  let result = "";

  if (firstBlockIndex > 0) {
    result += baseContent.slice(0, firstBlockIndex);
    cursor = firstBlockIndex;
  }

  if (insertMap.has(0)) {
    const startImages = insertMap.get(0) || [];
    result += `${startImages.join("\n")}\n`;
  }

  blocks.forEach((block, index) => {
    const start = baseContent.indexOf(block, cursor);
    if (start < 0) return;
    const end = start + block.length;
    result += baseContent.slice(cursor, end);
    cursor = end;

    const position = index + 1;
    if (insertMap.has(position)) {
      const imagesForPosition = insertMap.get(position) || [];
      result += `\n${imagesForPosition.join("\n")}`;
    }
  });

  result += baseContent.slice(cursor);
  return result.trim();
}

function buildArticleImageTag(src: string, title: string, isHero: boolean, imageIndex: number): string {
  const safeTitle = (title || "Article").replace(/"/g, "&quot;").trim() || "Article";
  const alt = isHero ? `${safeTitle} hero image` : `${safeTitle} image ${imageIndex}`;
  // C-028：加 referrerpolicy="no-referrer" 绕过外链图床的 hotlink / Referer 防盗链
  return isHero
    ? `<img src="${src}" alt="${alt}" referrerpolicy="no-referrer" style="width:100%;max-height:400px;object-fit:cover;border-radius:12px;margin:0 0 24px 0" loading="lazy" />`
    : `<img src="${src}" alt="${alt}" referrerpolicy="no-referrer" style="max-width:100%;border-radius:8px;margin:16px 0" loading="lazy" />`;
}

function isSameImageSource(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  return normalizeImageSourceKey(expected) === normalizeImageSourceKey(actual);
}

function normalizeImageSourceKey(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const lastPath = trimmed.split("?")[0].split("#")[0].split("/").filter(Boolean).pop() || trimmed;
  return lastPath.toLowerCase();
}
