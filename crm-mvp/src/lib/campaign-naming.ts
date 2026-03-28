import prisma from "@/lib/prisma";

/**
 * 校验名称是否符合系统命名格式: 序号-平台-商家名-国家(2字母)-日期(MMDD)-MID
 * 至少 6 段，且国家位(parts[3])为 2 位字母、日期位(parts[4])为 4 位数字
 */
function isSystemCampaignName(parts: string[]): boolean {
  if (parts.length < 6) return false;
  if (!/^\d+$/.test(parts[0])) return false;
  if (!/^[A-Z]{2}$/i.test(parts[3])) return false;
  if (!/^\d{4}$/.test(parts[4])) return false;
  return true;
}

/**
 * 从广告系列名称中提取序号（仅识别系统命名格式）
 */
function extractSeqFromName(name: string, namingRule: string, platformLabel?: string): number {
  if (!name) return 0;
  const parts = name.split("-");
  if (!isSystemCampaignName(parts)) return 0;

  if (namingRule === "per_platform") {
    if (platformLabel && parts[1]?.trim().toUpperCase() !== platformLabel.toUpperCase()) return 0;
  }

  return parseInt(parts[0], 10);
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
  // 按 MCC 过滤（含 mcc_id 为 NULL 的记录），不过滤 is_deleted 防止序号重复
  const dbWhere: Record<string, unknown> = { user_id: userId };
  if (mccId) {
    dbWhere.OR = [{ mcc_id: mccId }, { mcc_id: null }];
  }
  const dbMaxSeq = await prisma.$transaction(async (tx) => {
    const existingCampaigns = await tx.campaigns.findMany({
      where: dbWhere as any,
      select: { campaign_name: true },
    });

    let max = 0;
    let maxName = "";
    for (const c of existingCampaigns) {
      const num = extractSeqFromName(c.campaign_name || "", namingRule, platformLabel);
      if (num > max) { max = num; maxName = c.campaign_name || ""; }
    }
    if (max > 0) console.log(`[CampaignNaming] DB maxSeq=${max} from "${maxName}" (total ${existingCampaigns.length} campaigns)`);
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
              let batchMaxName = "";
              for (const row of rows) {
                const c = row.campaign as Record<string, unknown> | undefined;
                const name = String(c?.name ?? "");
                const num = extractSeqFromName(name, namingRule, platformLabel);
                if (num > batchMax) { batchMax = num; batchMaxName = name; }
              }
              if (batchMax > 0) console.log(`[CampaignNaming] Google Ads CID ${cid.customer_id} maxSeq=${batchMax} from "${batchMaxName}" (${rows.length} campaigns)`);
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
  console.log(`[CampaignNaming] Final: dbMax=${dbMaxSeq}, googleMax=${googleMaxSeq} → seq=${seqStr}`);
  return `${seqStr}-${platformLabel}-${cleanName}-${country}-${mmdd}-${merchantId}`;
}
