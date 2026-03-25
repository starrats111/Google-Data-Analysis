import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import Tesseract from "tesseract.js";

/**
 * POST /api/user/ad-creation/check-image
 * OCR 检测图片中是否含有文字
 * 接收 { url: string } 或 FormData (file)
 * 返回 { has_text: boolean, confidence: number, text: string }
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  try {
    let imageBuffer: Buffer;

    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file = formData.get("file") as File | null;
      if (!file) return apiError("缺少图片文件");
      imageBuffer = Buffer.from(await file.arrayBuffer());
    } else {
      const body = await req.json();
      const { url } = body;
      if (!url) return apiError("缺少图片 URL");

      if (url.startsWith("/api/")) {
        // 本地上传的图片
        const { readFile } = await import("fs/promises");
        const { existsSync } = await import("fs");
        const path = await import("path");
        const filename = url.split("/").pop();
        const filePath = path.join(process.cwd(), ".uploads", "ad-images", filename || "");
        if (!existsSync(filePath)) return apiError("图片文件不存在");
        imageBuffer = await readFile(filePath);
      } else {
        // 远程图片
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!resp.ok) return apiError(`图片下载失败: HTTP ${resp.status}`);
        imageBuffer = Buffer.from(await resp.arrayBuffer());
      }
    }

    if (imageBuffer.length > 10 * 1024 * 1024) {
      return apiError("图片过大（>10MB）");
    }

    // 使用 Tesseract.js 进行 OCR 检测
    const worker = await Tesseract.createWorker("eng");
    const { data } = await worker.recognize(imageBuffer);
    await worker.terminate();

    // 过滤掉低置信度的噪声识别（confidence < 50）
    const meaningfulWords = data.words.filter(
      (w) => w.confidence > 50 && w.text.trim().length >= 2
    );
    const detectedText = meaningfulWords.map((w) => w.text).join(" ").trim();
    const hasText = meaningfulWords.length >= 2; // 至少2个有意义的词才算有文字
    const avgConfidence = meaningfulWords.length > 0
      ? meaningfulWords.reduce((sum, w) => sum + w.confidence, 0) / meaningfulWords.length
      : 0;

    return apiSuccess({
      has_text: hasText,
      confidence: Math.round(avgConfidence),
      text: detectedText.slice(0, 200),
      word_count: meaningfulWords.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[CheckImage] OCR 检测失败:", msg);
    return apiError(`OCR 检测失败: ${msg.slice(0, 200)}`);
  }
}
