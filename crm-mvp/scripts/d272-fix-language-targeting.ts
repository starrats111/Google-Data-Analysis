/**
 * D-272 遗留处理（07 2026-08-22 13:40 拍板「单独走一次写操作」）：
 * 4 条因 /uk/ 路径误检测、带「乌克兰语」定向提交到 Google 的 paused 广告，
 * 语言定向纠成英语（乌克兰语 1036 → 英语 1000）。
 *
 * 通道：写走 Google Ads API mutateGoogleAds（pickCredential Token 池 + 429 换凭证重试）；
 *       前置反查与 mutate 后即时反查属写操作的一部分（数据通道铁律豁免项）。
 * 成功后回写 CRM 库 campaigns.language_id='en'，保持与 Google 真值一致。
 *
 * 用法（生产服务器 crm-mvp 目录）：
 *   npx tsx scripts/d272-fix-language-targeting.ts            # dry-run：只反查现状
 *   npx tsx scripts/d272-fix-language-targeting.ts --apply    # 真实执行
 */
process.loadEnvFile(".env");

const APPLY = process.argv.includes("--apply");
const CAMPAIGN_IDS = [24296n, 25007n, 25418n, 25974n];
const UK_CONST = "languageConstants/1036";
const EN_CONST = "languageConstants/1000";

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

interface LangCriterion {
  resourceName: string;
  languageConstant: string;
}

async function main() {
  const { default: prisma } = await import("../src/lib/prisma");
  const { queryGoogleAds, mutateGoogleAds } = await import("../src/lib/google-ads/client");

  log(`模式：${APPLY ? "APPLY（真实执行）" : "DRY-RUN（只反查，不改）"}`);

  for (const id of CAMPAIGN_IDS) {
    const c = await prisma.campaigns.findUnique({
      where: { id },
      select: {
        id: true, campaign_name: true, google_campaign_id: true,
        customer_id: true, mcc_id: true, language_id: true, status: true,
      },
    });
    if (!c?.google_campaign_id || !c.customer_id || !c.mcc_id) {
      log(`campaign ${id}: 缺 google_campaign_id/customer_id/mcc_id，跳过`);
      continue;
    }
    const mcc = await prisma.google_mcc_accounts.findUnique({
      where: { id: c.mcc_id },
      select: { mcc_id: true, developer_token: true, service_account_json: true },
    });
    if (!mcc) {
      log(`campaign ${id}: MCC ${c.mcc_id} 不存在，跳过`);
      continue;
    }
    const credentials = {
      mcc_id: mcc.mcc_id,
      developer_token: mcc.developer_token ?? "",
      service_account_json: mcc.service_account_json ?? "",
    };

    log(`── campaign ${id} ${c.campaign_name}（CID ${c.customer_id}，库内 language_id=${c.language_id}，status=${c.status}）`);

    const gaql = `
      SELECT campaign_criterion.resource_name, campaign_criterion.language.language_constant
      FROM campaign_criterion
      WHERE campaign.id = ${c.google_campaign_id}
        AND campaign_criterion.type = 'LANGUAGE'
        AND campaign_criterion.status != 'REMOVED'
    `;
    const readCriteria = async (): Promise<LangCriterion[]> => {
      const rows = await queryGoogleAds(credentials, c.customer_id!, gaql);
      return rows.map((r) => {
        const cc = r.campaignCriterion as Record<string, unknown>;
        const lang = cc?.language as Record<string, unknown> | undefined;
        return {
          resourceName: String(cc?.resourceName ?? ""),
          languageConstant: String(lang?.languageConstant ?? ""),
        };
      }).filter((x) => x.resourceName);
    };

    const before = await readCriteria();
    log(`  Google 现状语言定向：${before.map((b) => b.languageConstant).join(", ") || "（无 = 所有语言）"}`);

    const ukCriteria = before.filter((b) => b.languageConstant === UK_CONST);
    const hasEn = before.some((b) => b.languageConstant === EN_CONST);
    if (ukCriteria.length === 0) {
      log(`  无乌克兰语定向，无需处理`);
      continue;
    }

    const cid = c.customer_id.replace(/-/g, "");
    const ops: Record<string, unknown>[] = ukCriteria.map((u) => ({
      campaign_criterion_operation: { remove: u.resourceName },
    }));
    if (!hasEn) {
      ops.push({
        campaign_criterion_operation: {
          create: {
            campaign: `customers/${cid}/campaigns/${c.google_campaign_id}`,
            language: { language_constant: EN_CONST },
          },
        },
      });
    }
    log(`  计划操作：移除 ${ukCriteria.length} 条乌克兰语定向${hasEn ? "（英语已存在，不重复加）" : " + 新增英语定向"}`);

    if (!APPLY) continue;

    await mutateGoogleAds(credentials, c.customer_id, ops);

    // mutate 后即时反查确认（写操作的一部分）
    const after = await readCriteria();
    const stillUk = after.some((a) => a.languageConstant === UK_CONST);
    const nowEn = after.some((a) => a.languageConstant === EN_CONST);
    log(`  mutate 后反查：${after.map((a) => a.languageConstant).join(", ") || "（无）"}`);
    if (stillUk || !nowEn) {
      log(`  ❌ 反查不符预期（stillUk=${stillUk} nowEn=${nowEn}），不回写库，人工介入`);
      continue;
    }

    await prisma.campaigns.update({ where: { id }, data: { language_id: "en" } });
    log(`  ✅ Google 已改英语定向，CRM 库 language_id 已回写 en`);
  }

  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
