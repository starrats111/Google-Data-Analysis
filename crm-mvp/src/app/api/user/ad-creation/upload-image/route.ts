import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import crypto from "crypto";

const UPLOAD_DIR = path.join(process.cwd(), ".uploads", "ad-images");
const MAX_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/**
 * POST /api/user/ad-creation/upload-image
 * 上传商家图片（用于手动添加广告图片）
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return apiError("缺少文件");
    if (!ALLOWED_TYPES.includes(file.type)) return apiError("不支持的图片格式，仅支持 JPG/PNG/WebP/GIF");
    if (file.size > MAX_SIZE) return apiError("图片大小不能超过 10MB");

    if (!existsSync(UPLOAD_DIR)) {
      await mkdir(UPLOAD_DIR, { recursive: true });
    }

    const ext = file.name.split(".").pop() || "jpg";
    const hash = crypto.randomBytes(8).toString("hex");
    const filename = `${Date.now()}-${hash}.${ext}`;
    const filePath = path.join(UPLOAD_DIR, filename);

    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(filePath, buffer);

    const url = `/api/user/ad-creation/upload-image/${filename}`;
    return apiSuccess({ url, filename, size: file.size });
  } catch (err) {
    console.error("[Upload] 图片上传失败:", err);
    return apiError("图片上传失败");
  }
}

/**
 * GET /api/user/ad-creation/upload-image/[filename]
 * 暂不在此路由处理，见 serve-image 路由
 */
