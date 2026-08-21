/**
 * D-270 / Q-01：OCR.space 外部识图——OCR 彻底出服务器（07 2026-08-21 确认卡批准）
 *
 * 07 原话：「OCR 本来就不应该拖累服务器，要快速、便捷、省钱省资源。」
 * 方案：图片 URL 直接发给 OCR.space（免费档 2.5 万张/月、限 500 张/天/key），
 * 我们的服务器连图都不下载，零 CPU/内存消耗、零费用。
 *
 * 生产实测（2026-08-21）：Google 广告归档图 URL 直传可识别，域名行输出干净
 * （crocs.in / autodoc.nl 等首行即命中），单张 1.5-3s。
 *
 * 配置（system_configs）：
 *   - ocrspace_api_key      注册后填入（07 邮箱注册，免费）
 *   - ocr_engine=ocrspace   切换主引擎
 *   - ocrspace_daily_budget 每日调用上限（默认 450，留 50 余量防免费档 500/天限速）
 *
 * 域名挑选复用 ocr-local 的 pickDomainFromOcrText（TLD 白名单 + 根域归一 + 频次胜出），
 * 与 tesseract 通道口径完全一致。
 */

import { pickDomainFromOcrText } from "@/lib/ocr-local";

export interface OcrSpaceParsed {
  /** 识别出的整段文本；null = 处理失败 */
  text: string | null;
  /** 失败原因（含结构异常）；null = 成功 */
  error: string | null;
  /** 命中免费档限速/配额 */
  rateLimited: boolean;
}

/**
 * 解析 OCR.space 原始响应（纯函数可单测）。
 * 注意：限速时 OCR.space 返回的是纯文本而非 JSON
 * （如 "You may only perform this action upto maximum 500 number of times within 86400 seconds"）。
 */
export function parseOcrSpaceResponse(raw: string): OcrSpaceParsed {
  let data: {
    ParsedResults?: Array<{ ParsedText?: string; FileParseExitCode?: number }>;
    IsErroredOnProcessing?: boolean;
    OCRExitCode?: number;
    ErrorMessage?: string | string[];
  };
  try {
    data = JSON.parse(raw);
  } catch {
    const limitHit = /maximum\s+\d+\s+number of times|rate ?limit|too many requests/i.test(raw);
    return { text: null, error: raw.slice(0, 200), rateLimited: limitHit };
  }

  if (data.IsErroredOnProcessing || data.OCRExitCode !== 1) {
    const msg = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join("; ") : (data.ErrorMessage || `OCRExitCode=${data.OCRExitCode}`);
    return { text: null, error: msg.slice(0, 200), rateLimited: /maximum\s+\d+|rate ?limit|too many/i.test(msg) };
  }

  const text = (data.ParsedResults || []).map((r) => r.ParsedText || "").join("\n");
  return { text, error: null, rateLimited: false };
}

export interface OcrSpaceOutput {
  domain: string | null;
  raw: string;
}

/**
 * 识别一张广告图的投放域名。图片 URL 直传 OCR.space，本机零图像处理。
 * 限速 → 抛含 "rate_limit" 的错误（worker 既有 C-094.2 限流路径接手）；
 * 其他失败 → 抛普通错误（worker 既有 tries/permanent 逻辑接手）。
 */
export async function ocrSpaceImageDomain(imageUrl: string, apiKey: string): Promise<OcrSpaceOutput> {
  const body = new URLSearchParams({
    apikey: apiKey,
    url: imageUrl,
    OCREngine: "2",
    scale: "true",
    isOverlayRequired: "false",
  });

  const resp = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(70_000),
  });
  const rawText = await resp.text();

  if (resp.status === 403 || resp.status === 429) {
    throw new Error(`rate_limit: OCR.space HTTP ${resp.status}: ${rawText.slice(0, 120)}`);
  }
  if (!resp.ok) {
    throw new Error(`ocrspace HTTP ${resp.status}: ${rawText.slice(0, 120)}`);
  }

  const parsed = parseOcrSpaceResponse(rawText);
  if (parsed.rateLimited) {
    throw new Error(`rate_limit: ${parsed.error}`);
  }
  if (parsed.text === null) {
    throw new Error(`ocrspace: ${parsed.error}`);
  }

  const domain = pickDomainFromOcrText(parsed.text);
  const candidates = Array.from(
    new Set(parsed.text.toLowerCase().match(/([a-z0-9][a-z0-9-]*\.)+[a-z]{2,6}/g) ?? []),
  ).slice(0, 8);

  return { domain, raw: domain ?? `none; candidates: ${candidates.join(" ")}` };
}
