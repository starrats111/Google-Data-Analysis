/**
 * D-257 本地免费 OCR（Tesseract）——替代 AI 视觉模型提取广告图域名
 *
 * 背景（07 2026-08-20）：AI OCR 按图烧钱，ATC 归档图是服务器渲染的清晰文字截图，
 * 传统 OCR 完全够用。生产实测（40 张 AI 成功样本对照）：
 *   - 裸跑 tesseract：36/40 命中
 *   - 3x 放大 + 灰度 + 锐化预处理：39/40 文本命中，全自动挑选域名 37/40 正确
 *   - AI 判 permanent_failure 的图反而救回 8/10
 * 残余误差（小字单字符误读 / 纯 logo 无文字）对 5% 域名重复率判定无实质影响。
 *
 * 系统依赖（仅生产服务器）：apt 包 tesseract-ocr + imagemagick。
 * 本机/环境缺依赖时 isLocalOcrAvailable() 返回 false，worker 按配置降级或跳过。
 *
 * 管线：curl 下载 → convert 预处理 → tesseract（psm 11，无候选再 psm 3）→
 *       TLD 白名单挑域名 → 根域名归一化（eTLD+1）→ 频次最高者胜出
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

// ─── 依赖可用性探测（进程内缓存）───

let availability: boolean | null = null;

export async function isLocalOcrAvailable(): Promise<boolean> {
  if (availability !== null) return availability;
  try {
    await execFileAsync("tesseract", ["--version"], { timeout: 10_000 });
    await execFileAsync("curl", ["--version"], { timeout: 10_000 });
    availability = true;
  } catch {
    availability = false;
  }
  return availability;
}

// ─── 域名挑选 ───

/**
 * TLD 白名单：过滤 OCR 把普通句子误拼成「word.word」的假域名。
 * 广告主投放地区集中在欧美+主流电商 TLD，未覆盖的极小众 TLD 宁可漏掉。
 */
const TLD_WHITELIST = new Set([
  "com", "net", "org", "co", "io", "uk", "de", "fr", "es", "it", "nl", "se",
  "dk", "no", "fi", "pl", "ca", "us", "au", "nz", "jp", "kr", "cn", "hk",
  "tw", "in", "br", "mx", "shop", "store", "online", "site", "xyz", "top",
  "club", "vip", "life", "live", "world", "today", "ai", "app", "dev", "me",
  "tv", "cc", "eu", "ch", "at", "be", "ie", "pt", "sg", "my", "th", "ph",
  "vn", "id", "ae", "za", "tr", "info", "biz", "pro",
]);

/** 常见二级公共后缀（co.uk 等），根域名归一化时保留三段 */
const SECOND_LEVEL_SUFFIXES = new Set([
  "co.uk", "com.au", "co.nz", "co.jp", "com.hk", "com.sg", "com.my",
  "co.kr", "com.br", "com.mx", "co.za", "com.tr", "com.cn", "co.in",
]);

const OCR_BLOCK_DOMAINS = /^(google|gstatic|googlesyndication|googleadservices|doubleclick|youtube|facebook|instagram|twitter|tiktok)\./;

/** eTLD+1 归一化：uk.xtool.com → xtool.com；shop.foo.co.uk → foo.co.uk */
export function toRootDomain(domain: string): string {
  const parts = domain.split(".");
  if (parts.length <= 2) return domain;
  const lastTwo = parts.slice(-2).join(".");
  if (SECOND_LEVEL_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

const DOMAIN_TOKEN_RE = /^(https?:\/\/)?(www\.?)?([a-z0-9][a-z0-9-]*\.)+[a-z]{2,6}(\/\S*)?$/;

/**
 * 从 OCR 文本里挑出最可能的投放域名：
 * 按空白分词 → 域名形 token → TLD 白名单 → 剥 www/协议/路径 → 根域归一 → 频次最高
 */
export function pickDomainFromOcrText(text: string): string | null {
  const freq = new Map<string, number>();
  for (const rawToken of text.toLowerCase().split(/\s+/)) {
    const token = rawToken.replace(/[,;:!?()[\]{}'"«»]+$/g, "").replace(/^[,;:!?()[\]{}'"«»]+/g, "");
    if (!DOMAIN_TOKEN_RE.test(token)) continue;
    let d = token.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\.?/, "");
    const tld = d.split(".").pop()!;
    if (!TLD_WHITELIST.has(tld)) continue;
    d = toRootDomain(d);
    // 屏蔽检查必须放在根域归一化之后，否则 vm.tiktok.com 这类子域会漏网
    if (OCR_BLOCK_DOMAINS.test(d)) continue;
    freq.set(d, (freq.get(d) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [d, c] of freq) {
    // 频次相同取更长的（信息量更大，也避免 Map 顺序不稳定）
    if (c > bestCount || (c === bestCount && best !== null && d.length > best.length)) {
      best = d;
      bestCount = c;
    }
  }
  return best;
}

// ─── OCR 管线 ───

export interface LocalOcrOutput {
  /** 挑选出的根域名；null = 图中未识别到域名 */
  domain: string | null;
  /** OCR 提取到的域名候选串（写 raw_output 供排查）*/
  raw: string;
}

/** 图片已被 Google 删除（4xx）→ 调用方应标 permanent_failure */
export class ImageGoneError extends Error {}

async function runTesseract(imagePath: string, psm: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "tesseract",
    [imagePath, "stdout", "--psm", psm],
    { timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  return stdout;
}

/**
 * 下载 + 预处理 + 识别一张广告图。
 * 用 curl 下载（与 atc-direct 同理：Node fetch 的 TLS 指纹可能被 Google 拦，curl 实测畅通）。
 */
export async function localOcrImageDomain(imageUrl: string): Promise<LocalOcrOutput> {
  const dir = await mkdtemp(join(tmpdir(), "ocr-"));
  try {
    const img = join(dir, "img");
    const { stdout: httpCode } = await execFileAsync(
      "curl",
      ["-sS", "-m", "30", "-o", img, "-w", "%{http_code}", imageUrl],
      { timeout: 40_000 },
    );
    if (/^4(0[34]|10)$/.test(httpCode.trim())) {
      throw new ImageGoneError(`image HTTP ${httpCode.trim()}`);
    }
    if (httpCode.trim() !== "200") {
      throw new Error(`image download HTTP ${httpCode.trim()}`);
    }

    // 预处理：3x 放大 + 灰度 + 锐化（实测把小字误读从 4/40 降到 1/40）。
    // imagemagick 缺失时退回原图（裸跑命中率仍有 90%）。
    let target = img;
    try {
      const pp = join(dir, "pp.png");
      await execFileAsync(
        "convert",
        [img, "-resize", "300%", "-colorspace", "Gray", "-sharpen", "0x1", pp],
        { timeout: 60_000 },
      );
      target = pp;
    } catch {
      /* 无 convert 或转换失败 → 用原图 */
    }

    let text = await runTesseract(target, "11");
    let domain = pickDomainFromOcrText(text);
    if (!domain) {
      // 稀疏模式没找到再试默认版面分析（两种 psm 对不同排版各有胜场）
      text = await runTesseract(target, "3");
      domain = pickDomainFromOcrText(text);
    }

    const candidates = Array.from(
      new Set(
        text.toLowerCase().match(/([a-z0-9][a-z0-9-]*\.)+[a-z]{2,6}/g) ?? [],
      ),
    ).slice(0, 8);

    return { domain, raw: domain ? domain : `none; candidates: ${candidates.join(" ")}` };
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
