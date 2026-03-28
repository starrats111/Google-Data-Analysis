import prisma from "@/lib/prisma";

/**
 * 从广告系列名称中提取序号
 */
function extractSeqFromName(name: string, namingRule: string, platformLabel?: string): number {
  if (!name) return 0;
  if (namingRule === "per_platform") {
    const parts = name.split("-");
    if (parts.length < 2) return 0;
    if (platformLabel && parts[1]?.trim().toUpperCase() !== platformLabel.toUpperCase()) return 0;
    const seqPart = parts[0].replace(/^[a-zA-Z]+/, "");
    if (!/^\d+$/.test(seqPart)) return 0;
    return parseInt(seqPart, 10);
  } else {
    const firstPart = name.split("-")[0] || "";
    const seqPart = firstPart.replace(/^[a-zA-Z]+/, "");
    if (!/^\d+$/.test(seqPart)) return 0;
    return parseInt(seqPart, 10);
  }
}

/**
 * 生成广告系列名称
 * 格式: {序号}-{平台}-{商家名}-{国家}-{日期MMDD}-{MID}
 * 序号取 CRM 数据库 和 Google Ads 中已有名称的最大值 + 1
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

  // 1. 从 CRM 数据库查 maxSeq（带事务锁防并发）
  // 不过滤 is_deleted 和 mcc_id，确保序号全局递增、不重复、不跳号
  const dbMaxSeq = await prisma.$transaction(async (tx) => {
    const existingCampaigns = await tx.campaigns.findMany({
      where: { user_id: userId },
      select: { campaign_name: true },
    });

    let max = 0;
    for (const c of existingCampaigns) {
      const num = extractSeqFromName(c.campaign_name || "", namingRule, platformLabel);
      if (num > max) max = num;
    }
    return max;
  }, { isolationLevel: "Serializable" });

  // 2. 从 Google Ads 查该 MCC 下所有 CID 的 campaign 名称，提取 maxSeq
  let googleMaxSeq = 0;
  if (mccId) {
    try {
      const mccAccount = await prisma.google_mcc_accounts.findFirst({
        where: { id: mccId, is_deleted: 0 },
      });
      if (mccAccount?.service_account_json && mccAccount?.developer_token) {
        const { queryGoogleAds } = await import("@/lib/google-ads/client");
        const credentials = {
          mcc_id: mccAccount.mcc_id,
          developer_token: mccAccount.developer_token,
          service_account_json: mccAccount.service_account_json,
        };

        // 查该 MCC 下所有活跃 CID
        const cids = await prisma.mcc_cid_accounts.findMany({
          where: { mcc_account_id: mccId, is_deleted: 0 },
          select: { customer_id: true },
        });

        const cidSlice = cids.slice(0, 10);
        const BATCH = 5;
        const timeoutMs = 8000;
        const deadline = Date.now() + timeoutMs;

        for (let i = 0; i < cidSlice.length; i += BATCH) {
          if (Date.now() >= deadline) {
            console.warn(`[CampaignNaming] Google Ads 查询已超 ${timeoutMs}ms，跳过剩余 CID`);
            break;
          }
          const batch = cidSlice.slice(i, i + BATCH);
          const results = await Promise.allSettled(
            batch.map(async (cid) => {
              const rows = await queryGoogleAds(credentials, cid.customer_id.replace(/-/g, ""), `
                SELECT campaign.name
                FROM campaign
                WHERE campaign.status != 'REMOVED'
              `);
              let batchMax = 0;
              for (const row of rows) {
                const c = row.campaign as Record<string, unknown> | undefined;
                const name = String(c?.name ?? "");
                const num = extractSeqFromName(name, namingRule, platformLabel);
                if (num > batchMax) batchMax = num;
              }
              return batchMax;
            }),
          );
          for (const r of results) {
            if (r.status === "fulfilled" && r.value > googleMaxSeq) {
              googleMaxSeq = r.value;
            }
          }
        }
      }
    } catch (err) {
      console.warn("[CampaignNaming] Google Ads 查询失败，仅使用数据库序号:", err instanceof Error ? err.message : err);
    }
  }

  const maxSeq = Math.max(dbMaxSeq, googleMaxSeq);
  const seqStr = String(maxSeq + 1).padStart(3, "0");
  return `${seqStr}-${platformLabel}-${cleanName}-${country}-${mmdd}-${merchantId}`;
}
