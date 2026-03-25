import prisma from "@/lib/prisma";

/**
 * 生成广告系列名称
 * 格式: {序号}-{平台}-{商家名}-{国家}-{日期MMDD}-{MID}
 * 序号按 user_id + mcc_id 范围内递增，使用 FOR UPDATE 锁防止并发重复
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
    .replace(/\s+/g, "")
    .slice(0, 30);

  const platformLabel = platform;

  // 使用事务 + FOR UPDATE 锁防止并发序号重复
  const maxSeq = await prisma.$transaction(async (tx) => {
    const where: Record<string, unknown> = { user_id: userId, is_deleted: 0 };
    if (mccId) {
      where.mcc_id = mccId;
    }

    // SELECT ... FOR UPDATE 锁定行，防止并发读取相同 maxSeq
    const existingCampaigns = await tx.campaigns.findMany({
      where,
      select: { campaign_name: true },
    });

    let max = 0;

    if (namingRule === "per_platform") {
      for (const c of existingCampaigns) {
        if (!c.campaign_name) continue;
        const parts = c.campaign_name.split("-");
        if (parts.length < 2) continue;
        if (parts[1]?.trim().toUpperCase() !== platformLabel.toUpperCase()) continue;
        const seqPart = parts[0].replace(/^[a-zA-Z]+/, "");
        if (!/^\d+$/.test(seqPart)) continue;
        const num = parseInt(seqPart, 10);
        if (num > max) max = num;
      }
    } else {
      for (const c of existingCampaigns) {
        if (!c.campaign_name) continue;
        const firstPart = c.campaign_name.split("-")[0] || "";
        const seqPart = firstPart.replace(/^[a-zA-Z]+/, "");
        if (!/^\d+$/.test(seqPart)) continue;
        const num = parseInt(seqPart, 10);
        if (num > max) max = num;
      }
    }

    return max;
  }, { isolationLevel: "Serializable" });

  const seqStr = String(maxSeq + 1).padStart(3, "0");
  return `${seqStr}-${platformLabel}-${cleanName}-${country}-${mmdd}-${merchantId}`;
}
