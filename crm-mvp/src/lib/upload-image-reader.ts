import { existsSync } from "fs";
import { readFile } from "fs/promises";
import path from "path";

const UPLOAD_DIR = path.join(process.cwd(), ".uploads", "ad-images");

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * 根据内部 /api/user/ad-creation/upload-image/{filename} URL 读取本地文件
 * 供发布器本地化流程使用
 */
export async function readUploadedImageBuffer(
  internalUrl: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const match = internalUrl.match(/\/api\/user\/ad-creation\/upload-image\/([^?#]+)/i);
  if (!match) return null;

  const filename = match[1];
  const filePath = path.join(UPLOAD_DIR, filename);

  if (!existsSync(filePath)) {
    console.warn(`[UploadReader] 文件不存在: ${filePath}`);
    return null;
  }

  const buffer = await readFile(filePath);
  const ext = path.extname(filename).replace(".", "").toLowerCase();
  const contentType = EXT_MIME[ext] || "image/jpeg";

  return { buffer, contentType };
}
