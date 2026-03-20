import prisma from "@/lib/prisma";

/**
 * 生成广告系列名称
 * 格式: {序号}-{平台}-{商家名}-{国家}-{日期MMDD}-{MID}
 * 示例: 011-CG-Crocs-FR-0320-3016607
 * 序号基于现有最大值递增，避免删除后重号
 */
export async function generateCampaignName(
  userId: bigint,
  platform: string,
  merchantName: string,
  country: string,
  merchantId: string,
  namingRule: string,
): Promise<string> {
  const now = new Date();
  const mmdd = `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const cleanName = merchantName.replace(/[^a-zA-Z0-9\u4e00-\u9fff ]/g, "").trim().slice(0, 30);

  const existingCampaigns = await prisma.campaigns.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { campaign_name: true },
  });

  let maxSeq = 0;

  if (namingRule === "per_platform") {
    for (const c of existingCampaigns) {
      if (!c.campaign_name) continue;
      const parts = c.campaign_name.split("-");
      if (parts.length < 2) continue;
      if (parts[1]?.trim().toUpperCase() !== platform.toUpperCase()) continue;
      const num = parseInt(parts[0], 10);
      if (!isNaN(num) && num > maxSeq) maxSeq = num;
    }
  } else {
    for (const c of existingCampaigns) {
      if (!c.campaign_name) continue;
      const firstPart = c.campaign_name.split("-")[0] || "";
      const num = parseInt(firstPart, 10);
      if (!isNaN(num) && num > maxSeq) maxSeq = num;
    }
  }

  const seqStr = String(maxSeq + 1).padStart(3, "0");
  return `${seqStr}-${platform}-${cleanName}-${country}-${mmdd}-${merchantId}`;
}
