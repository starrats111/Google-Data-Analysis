import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import crypto from "crypto";

const UPLOAD_DIR = path.join(process.cwd(), ".uploads", "ad-images");
const MAX_SIZE = 5 * 1024 * 1024; // 5MB — Google Ads 图片素材上限
const ALLOWED_TYPES = ["image/jpeg", "image/png"]; // Google Ads 搜索广告系列仅支持 PNG/JPG
const MIN_DIMENSION = 300; // Google Ads 方形图片最低 300×300

function getImageDimensions(buffer: Buffer, mimeType: string): { width: number; height: number } | null {
  try {
    if (mimeType === "image/png") {
      if (buffer.length < 24) return null;
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (mimeType === "image/jpeg") {
      let offset = 2;
      while (offset < buffer.length - 9) {
        if (buffer[offset] !== 0xFF) break;
        const marker = buffer[offset + 1];
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        const segLen = buffer.readUInt16BE(offset + 2);
        offset += 2 + segLen;
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * POST /api/user/ad-creation/upload-image
 * 上传商家图片（用于手动添加广告图片）
 * 校验：格式（PNG/JPG）、大小（≤5MB）、尺寸（≥300×300px）
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return apiError("缺少文件");
    if (!ALLOWED_TYPES.includes(file.type)) return apiError("不支持的图片格式，Google Ads 仅支持 JPG/PNG");
    if (file.size > MAX_SIZE) return apiError("图片大小不能超过 5MB（Google Ads 限制）");

    if (!existsSync(UPLOAD_DIR)) {
      await mkdir(UPLOAD_DIR, { recursive: true });
    }

    const ext = file.name.split(".").pop() || "jpg";
    const hash = crypto.randomBytes(8).toString("hex");
    const filename = `${Date.now()}-${hash}.${ext}`;
    const filePath = path.join(UPLOAD_DIR, filename);

    const buffer = Buffer.from(await file.arrayBuffer());

    const dimensions = getImageDimensions(buffer, file.type);
    if (dimensions) {
      const { width, height } = dimensions;
      if (width < MIN_DIMENSION || height < MIN_DIMENSION) {
        return apiError(`图片尺寸过小 (${width}×${height})，Google Ads 要求最低 ${MIN_DIMENSION}×${MIN_DIMENSION} 像素`);
      }
    }

    await writeFile(filePath, buffer);

    const url = `/api/user/ad-creation/upload-image/${filename}`;
    return apiSuccess({ url, filename, size: file.size });
  } catch (err) {
    console.error("[Upload] 图片上传失败:", err);
    return apiError("图片上传失败");
  }
}
