import prisma from "@/lib/prisma";

/**
 * 生成广告系列名称
 * 格式: {prefix}{序号}-{平台}-{商家名}-{国家}-{日期MMDD}-{MID}
 * 序号按 MCC 分开统计，每个 MCC 独立递增
 */
export async function generateCampaignName(
  userId: bigint,
  platform: string,
  merchantName: string,
  country: string,
  merchantId: string,
  namingRule: string,
  accountName?: string,
  namingPrefix?: string,
  mccId?: bigint | null,
): Promise<string> {
  const now = new Date();
  const mmdd = `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const cleanName = merchantName
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff ]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 30);

  const platformLabel = platform;

  const where: Record<string, unknown> = { user_id: userId, is_deleted: 0 };
  if (mccId) {
    where.OR = [{ mcc_id: mccId }, { mcc_id: null }];
  }

  const existingCampaigns = await prisma.campaigns.findMany({
    where,
    select: { campaign_name: true },
  });

  let maxSeq = 0;
  const prefix = namingPrefix?.trim() || "";

  if (namingRule === "per_platform") {
    for (const c of existingCampaigns) {
      if (!c.campaign_name) continue;
      const parts = c.campaign_name.split("-");
      if (parts.length < 2) continue;
      if (parts[1]?.trim().toUpperCase() !== platformLabel.toUpperCase()) continue;
      const seqPart = parts[0].replace(/^[a-zA-Z]+/, "");
      if (!/^\d+$/.test(seqPart)) continue;
      const num = parseInt(seqPart, 10);
      if (num > maxSeq) maxSeq = num;
    }
  } else {
    for (const c of existingCampaigns) {
      if (!c.campaign_name) continue;
      const firstPart = c.campaign_name.split("-")[0] || "";
      const seqPart = firstPart.replace(/^[a-zA-Z]+/, "");
      if (!/^\d+$/.test(seqPart)) continue;
      const num = parseInt(seqPart, 10);
      if (num > maxSeq) maxSeq = num;
    }
  }

  const seqStr = `${prefix}${String(maxSeq + 1).padStart(3, "0")}`;
  return `${seqStr}-${platformLabel}-${cleanName}-${country}-${mmdd}-${merchantId}`;
}
