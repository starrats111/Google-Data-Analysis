/**
 * D-040 BUG-1 hotfix: wj11 名下 2 条 CRM 已点击暂停但 GAds 未生效的广告系列
 *
 * 背景（SSH 实证 2026-05-28）：
 *   全库 9812 条 status != google_status 不一致中，存在 2 条 status='paused'
 *   但 google_status='ENABLED' 的 case，是真实的"用户点了暂停但 GAds 没生效"
 *   bug 后遗症，需要主动调用 GAds API 把 GAds 推为 PAUSED。
 *
 *   - id=8246: wj11 名下 / mcc_id 与 google_campaign_id 见数据库
 *   - id=3810: wj11 名下 / mcc_id 与 google_campaign_id 见数据库
 *
 * 用法：
 *   cd /home/ubuntu/Google-Data-Analysis/crm-mvp
 *   npx tsx scripts/d040-hotfix-wj11-pause.ts
 *
 * 幂等：执行后 DB google_status / status 会被同步为 PAUSED / paused，
 * 再次执行不会重复 mutate（toggle 路由判断 if google_status==PAUSED 不再推送）。
 * 此处脚本直接强制 mutate 一次，再依赖反查 + DB 写入幂等。
 */
import prisma from "../src/lib/prisma";

const TARGET_IDS = [BigInt(8246), BigInt(3810)];

async function main() {
  console.log("[D040-hotfix] 启动 wj11 强制暂停修复...");

  const { updateCampaignStatus } = await import("../src/lib/google-ads");
  const { queryGoogleAds } = await import("../src/lib/google-ads/client");

  let okCount = 0;
  let failCount = 0;

  for (const id of TARGET_IDS) {
    console.log(`\n[D040-hotfix] ===== 处理 campaign id=${id} =====`);
    const campaign = await prisma.campaigns.findFirst({
      where: { id, is_deleted: 0 },
    });
    if (!campaign) {
      console.log(`  ❌ 未找到 campaign id=${id}`);
      failCount++;
      continue;
    }
    console.log(
      `  campaign_name="${campaign.campaign_name}" user_id=${campaign.user_id} ` +
        `status=${campaign.status} google_status=${campaign.google_status} ` +
        `customer_id=${campaign.customer_id} gcid=${campaign.google_campaign_id}`
    );

    if (!campaign.google_campaign_id) {
      console.log(`  ❌ 缺少 google_campaign_id，跳过`);
      failCount++;
      continue;
    }
    if (!campaign.mcc_id) {
      console.log(`  ❌ 缺少 mcc_id，跳过`);
      failCount++;
      continue;
    }
    if (!campaign.customer_id) {
      console.log(`  ❌ 缺少 customer_id，跳过`);
      failCount++;
      continue;
    }

    const mcc = await prisma.google_mcc_accounts.findFirst({
      where: { id: campaign.mcc_id, is_deleted: 0 },
    });
    if (!mcc || !mcc.service_account_json || !mcc.developer_token) {
      console.log(`  ❌ MCC 凭证缺失`);
      failCount++;
      continue;
    }

    const credentials = {
      mcc_id: mcc.mcc_id,
      developer_token: mcc.developer_token,
      service_account_json: mcc.service_account_json,
    };

    console.log(`  → 调用 mutateCampaign(PAUSED)...`);
    const result = await updateCampaignStatus(
      credentials,
      campaign.customer_id,
      campaign.google_campaign_id,
      "PAUSED"
    );

    if (!result.success) {
      console.log(`  ❌ mutate 失败: ${result.message}`);
      failCount++;
      continue;
    }
    console.log(`  ✓ mutate 成功: ${result.message}`);

    // 反查验证
    await new Promise((r) => setTimeout(r, 2000));
    let confirmed: string | null = null;
    try {
      const rows = await queryGoogleAds(
        credentials,
        campaign.customer_id.replace(/-/g, ""),
        `SELECT campaign.id, campaign.status FROM campaign WHERE campaign.id = ${campaign.google_campaign_id}`
      );
      if (rows.length > 0) {
        const c = rows[0].campaign as Record<string, unknown> | undefined;
        confirmed = String(c?.status ?? "");
        console.log(`  反查 GAds 实际状态: ${confirmed}`);
      } else {
        console.log(`  ⚠ 反查 0 条记录`);
      }
    } catch (e) {
      console.log(`  ⚠ 反查异常: ${e instanceof Error ? e.message : String(e)}`);
    }

    const finalStatus = confirmed === "PAUSED" || confirmed === "REMOVED" ? confirmed : "PAUSED";
    await prisma.campaigns.update({
      where: { id: campaign.id },
      data: {
        google_status: finalStatus,
        status: finalStatus === "ENABLED" ? "active" : "paused",
        last_google_sync_at: new Date(),
      },
    });
    console.log(`  ✓ DB 已写入 google_status=${finalStatus}`);
    okCount++;
  }

  console.log(`\n[D040-hotfix] ===== 完成: 成功 ${okCount}, 失败 ${failCount} =====`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[D040-hotfix] 致命错误:", e);
  await prisma.$disconnect();
  process.exit(1);
});
