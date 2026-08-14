/**
 * D-238 广告分析配置入库（提示词 + AI 提供商 + 场景模型）
 *
 * 运行方式（服务器上）：
 *   AICODEWITH_API_KEY=sk-xxx npx tsx scripts/d238-seed-analysis-config.ts
 *
 * 做三件事，全部幂等（重复执行只更新不重复插入）：
 *   1. system_configs：写入主/辅两段提示词（源自 kyads 生产库 UTF-8 原样导出，
 *      文件在 prisma/seed-data/d238_*.txt）+ 目标 ROI 400 / 目标 CPA $1（kyads 生产实值）
 *   2. ai_providers：aicodewith（Anthropic 协议，base https://api.aicodewith.com ）
 *      API Key 从环境变量 AICODEWITH_API_KEY 读取，不硬编码进仓库；
 *      provider 已存在且未传 Key 时保留原 Key 不动
 *   3. ai_model_configs：场景 campaign_ad_analysis → claude-haiku-4-5-20251001（与 kyads 同款）
 */
import { readFileSync } from "fs";
import { join } from "path";
import prisma from "../src/lib/prisma";

const SEED_DIR = join(__dirname, "..", "prisma", "seed-data");
const PROVIDER_NAME = "aicodewith";
const SCENE = "campaign_ad_analysis";
const MODEL_NAME = "claude-haiku-4-5-20251001";

async function upsertConfig(key: string, value: string, description: string) {
  await prisma.system_configs.upsert({
    where: { config_key: key },
    update: { config_value: value, description, is_deleted: 0 },
    create: { config_key: key, config_value: value, description },
  });
  console.log(`  system_configs.${key} 已写入（${value.length} 字符）`);
}

async function main() {
  console.log("=== D-238 广告分析配置入库 ===\n");

  // 1) 提示词 + 分析目标
  const mainPrompt = readFileSync(join(SEED_DIR, "d238_main_prompt.txt"), "utf-8").trim();
  const auxPrompt = readFileSync(join(SEED_DIR, "d238_aux_prompt.txt"), "utf-8").trim();
  if (mainPrompt.length < 1000 || auxPrompt.length < 1000) {
    throw new Error(`提示词文件疑似不完整：main=${mainPrompt.length} aux=${auxPrompt.length} 字符`);
  }
  console.log("[1/3] 写入提示词与分析目标");
  await upsertConfig("campaign_ad_analysis_main_prompt", mainPrompt, "D-238 广告分析主决策提示词（含平衡/进攻/保守三策略切片，源自 kyads）");
  await upsertConfig("campaign_ad_analysis_aux_prompt", auxPrompt, "D-238 广告分析辅助层提示词（门控标签，源自 kyads）");
  await upsertConfig("campaign_ad_analysis_target_roi", "400", "D-238 分析目标 ROI %（kyads 生产实值）");
  await upsertConfig("campaign_ad_analysis_target_cpa", "1", "D-238 分析目标 CPA $（kyads 生产实值）");

  // 2) AI 提供商
  console.log("\n[2/3] 配置 aicodewith 提供商（Anthropic 协议）");
  const apiKey = process.env.AICODEWITH_API_KEY || "";
  let provider = await prisma.ai_providers.findFirst({
    where: { provider_name: PROVIDER_NAME, is_deleted: 0 },
  });
  if (provider) {
    provider = await prisma.ai_providers.update({
      where: { id: provider.id },
      data: {
        api_base_url: "https://api.aicodewith.com",
        protocol: "anthropic",
        status: "active",
        ...(apiKey ? { api_key: apiKey } : {}),
      },
    });
    console.log(`  已更新现有 provider id=${provider.id}${apiKey ? "（含新 Key）" : "（保留原 Key）"}`);
  } else {
    if (!apiKey) {
      throw new Error("provider aicodewith 不存在且未提供 AICODEWITH_API_KEY，无法创建。请带环境变量重跑。");
    }
    provider = await prisma.ai_providers.create({
      data: {
        provider_name: PROVIDER_NAME,
        api_key: apiKey,
        api_base_url: "https://api.aicodewith.com",
        protocol: "anthropic",
        status: "active",
      },
    });
    console.log(`  已创建 provider id=${provider.id}`);
  }

  // 3) 场景模型
  console.log("\n[3/3] 配置场景模型");
  const existing = await prisma.ai_model_configs.findFirst({
    where: { scene: SCENE, provider_id: provider.id, model_name: MODEL_NAME, is_deleted: 0 },
  });
  if (existing) {
    await prisma.ai_model_configs.update({
      where: { id: existing.id },
      data: { is_active: 1, priority: 1, max_tokens: 6000, temperature: 0.7 },
    });
    console.log(`  已更新场景模型 id=${existing.id}`);
  } else {
    const created = await prisma.ai_model_configs.create({
      data: {
        scene: SCENE,
        provider_id: provider.id,
        model_name: MODEL_NAME,
        max_tokens: 6000,
        temperature: 0.7,
        is_active: 1,
        priority: 1,
      },
    });
    console.log(`  已创建场景模型 id=${created.id}`);
  }

  console.log("\n=== 完成。可用 GET /api/cron/analyze-campaigns（带 CRON_SECRET）手动触发验证 ===");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
