import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { extractDomain } from "@/lib/atc-service";

/**
 * PATCH /api/user/merchants/:id/category
 * D-166：人工修正商家主营业务（category）。
 * 修正后全系统同步更正：
 *   ① 同平台同 MID 的全部用户记录；
 *   ② merchant_url 域名（去 www）相同的全系统全平台全用户记录。
 * 被修正的记录打 category_manual=1 标记，之后平台商家同步不再覆盖 category。
 * body: { category: string }
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { id } = await params;
  if (!id) return apiError("缺少商家 ID");

  let body: { category?: string } = {};
  try {
    body = await req.json();
  } catch {
    return apiError("请求体解析失败");
  }
  const category = String(body.category || "").trim();
  if (!category) return apiError("请填写主营业务");
  if (category.length > 128) return apiError("主营业务不能超过 128 个字符");

  // 只能从自己的商家发起修改（传播会更正其他用户的同域名记录）
  const merchant = await prisma.user_merchants.findFirst({
    where: { id: BigInt(id), user_id: BigInt(user.userId) },
    select: { id: true, platform: true, merchant_id: true, merchant_url: true },
  });
  if (!merchant) return apiError("商家不存在或无权限", 404);

  // ── 收集同步目标：同平台同 MID ∪ 同域名 ──
  const targetIds = new Set<bigint>([merchant.id]);

  const sameMid = await prisma.user_merchants.findMany({
    where: { platform: merchant.platform, merchant_id: merchant.merchant_id },
    select: { id: true },
  });
  for (const m of sameMid) targetIds.add(m.id);

  const domain = extractDomain(merchant.merchant_url);
  if (domain) {
    // contains 预筛后再用 extractDomain 精确比对，避免 abc.com 误中 xabc.com
    const candidates = await prisma.user_merchants.findMany({
      where: { merchant_url: { contains: domain } },
      select: { id: true, merchant_url: true },
    });
    for (const c of candidates) {
      if (extractDomain(c.merchant_url) === domain) targetIds.add(c.id);
    }
  }

  const ids = [...targetIds];
  const updated = await prisma.user_merchants.updateMany({
    where: { id: { in: ids } },
    data: { category, category_manual: 1 },
  });

  console.log(
    `[MerchantCategory] user=${user.userId} 修正 ${merchant.platform}:${merchant.merchant_id}` +
    ` 主营业务="${category}" domain=${domain || "-"} 同步更正 ${updated.count} 条记录`,
  );

  return apiSuccess(
    serializeData({ updated: updated.count, domain }),
    domain
      ? `已更新，并同步更正全系统 ${updated.count} 条同域名（${domain}）/同MID商家记录`
      : `已更新，并同步更正全系统 ${updated.count} 条同MID商家记录`,
  );
}
