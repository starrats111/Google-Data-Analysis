/**
 * C-088 前端轮询接口
 *
 * 前端搜索响应里若有 ad._ocrPending=true 的项 → 每 5s 用这些 image_url 查一次状态。
 *  - 成功识别 → 把 ad.domain 填上，前端 state 移除 _ocrPending
 *  - 失败/永久失败 → 移除 _ocrPending，UI 显示 "-"
 *
 * 请求：POST /api/user/intelligence/ocr-status
 *   body: { urls: string[] }
 * 响应：
 *   { code: 0, data: { [imageUrl]: { status: 'success'|'failed'|'permanent_failure'|'pending'|'processing', domain?: string } } }
 */
import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import { queryCachedDomains } from "@/lib/ocr-domain";

export const POST = withUser(async (req: NextRequest) => {
  let body: { urls?: unknown };
  try {
    body = (await req.json()) as { urls?: unknown };
  } catch {
    return NextResponse.json({ code: 400, message: "JSON 解析失败" }, { status: 400 });
  }

  const urls = Array.isArray(body.urls)
    ? body.urls
        .filter((u): u is string => typeof u === "string" && u.length > 0 && u.length <= 768)
        .slice(0, 200)
    : [];

  if (urls.length === 0) return NextResponse.json({ code: 0, data: {} });

  const cache = await queryCachedDomains(urls);

  const data: Record<string, { status: string; domain?: string }> = {};
  for (const url of urls) {
    const hit = cache.get(url);
    if (!hit) {
      data[url] = { status: "pending" };
    } else {
      data[url] = { status: hit.status ?? "pending", domain: hit.domain };
    }
  }

  return NextResponse.json({ code: 0, data });
});
