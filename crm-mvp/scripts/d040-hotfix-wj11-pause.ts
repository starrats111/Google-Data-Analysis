/**
 * D-040 v2 — wj11 历史不一致广告强制暂停 hotfix
 *
 * 背景（07 Q-A：a 立即手动同步）：
 *   SSH 实证全库 `status='paused' AND google_status IN ('ENABLED','ACTIVE')` 仅 2 条：
 *     id=8246  user_id=11(wj11)  629-MUI1-BRUNTWorkwear-US-0511-8003665
 *     id=3810  user_id=11(wj11)  445-PM1-gog-US-0402-18647098
 *   这是真正"CRM 点了暂停但 GAds 没暂停"的反向不同步 case，需推 GAds API 强制暂停。
 *
 * 跑法（生产服务器）：
 *   ssh ubuntu@43.156.142.141
 *   cd /home/ubuntu/Google-Data-Analysis/crm-mvp
 *   npx tsx scripts/d040-hotfix-wj11-pause.ts
 *
 * 风险：调用 GAds mutateCampaign 真实写操作。脚本会先 dry-run 打印 plan，再询问确认 (env CONFIRM=1)。
 */

import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";
loadEnvFromProjectRoot();
import prisma from "../src/lib/prisma";

const TARGET_IDS = [8246n, 3810n];
const DRY_RUN = process.env.CONFIRM !== "1";

(async () => {
  console.log("=".repeat(70));
  console.log("D-040 v2 — wj11 hotfix（强制 GAds PAUSED）");
  console.log("DRY_RUN =", DRY_RUN, DRY_RUN ? "(set CONFIRM=1 to actually call GAds API)" : "");
  console.log("=".repeat(70));

  for (const id of TARGET_IDS) {
    const c = await prisma.campaigns.findFirst({
      where: { id, is_deleted: 0 },
    });
    if (!c) {
      console.log(`[Skip] id=${id} not found`);
      continue;
    }
    console.log(`\n=== campaign id=${c.id} user_id=${c.user_id} ===`);
    console.log(`  name: ${c.campaign_name}`);
    console.log(`  google_campaign_id: ${c.google_campaign_id}`);
    console.log(`  customer_id: ${c.customer_id}`);
    console.log(`  mcc_id: ${c.mcc_id}`);
    console.log(`  status: ${c.status}  google_status: ${c.google_status}`);

    if (!c.google_campaign_id || !c.customer_id || !c.mcc_id) {
      console.log("  [Skip] missing gcid/cid/mcc_id");
      continue;
    }

    const mcc = await prisma.google_mcc_accounts.findFirst({
      where: { id: c.mcc_id, is_deleted: 0 },
    });
    if (!mcc || !mcc.developer_token || !mcc.service_account_json) {
      console.log("  [Skip] MCC 凭证缺失");
      continue;
    }

    if (DRY_RUN) {
      console.log("  [DRY_RUN] 将调用 updateCampaignStatus → PAUSED");
      continue;
    }

    const { updateCampaignStatus } = await import("../src/lib/google-ads");
    const credentials = {
      mcc_id: mcc.mcc_id,
      developer_token: mcc.developer_token,
      service_account_json: mcc.service_account_json,
    };
    console.log("  [DO] 调用 updateCampaignStatus → PAUSED ...");
    const result = await updateCampaignStatus(
      credentials,
      c.customer_id,
      c.google_campaign_id,
      "PAUSED",
    );
    console.log("  result:", result);
    if (result.success) {
      await prisma.campaigns.update({
        where: { id: c.id },
        data: {
          status: "paused",
          google_status: "PAUSED",
          last_google_sync_at: new Date(),
        },
      });
      console.log("  [OK] DB 已同步 status=paused / google_status=PAUSED");
    } else {
      console.log("  [FAIL]", result.message);
    }
  }

  console.log("\nDone.");
  await prisma.$disconnect();
  process.exit(0);
})();
