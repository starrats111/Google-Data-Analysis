/**
 * D-041 backfill — 扫 PM2 错误日志回填历史拒登记录到 policy_violations 表
 *
 * 数据源：/home/ubuntu/.pm2/logs/ad-automation-error*.log
 *
 * 局限：现有日志只存了人话错误消息（已过 formatGoogleAdsErrorMessage），
 *   没有 raw policyViolationDetails JSON。所以 backfill 数据精度有限：
 *   - violating_text = trigger 原值
 *   - policy_name = "backfill_from_log"（标记数据来源）
 *   - 4 大类映射靠人话错误关键词模糊匹配
 *
 * 使用：
 *   ssh ubuntu@43.156.142.141
 *   cd ~/Google-Data-Analysis/crm-mvp
 *   npx tsx scripts/d041-backfill-policy-violations.ts [--dry-run] [--days=30]
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import prisma from "../src/lib/prisma";
import { mapToPolicyCategory } from "../src/lib/policy-hub/policy-categories";

const LOG_DIR = "/home/ubuntu/.pm2/logs";
const DEFAULT_DAYS = 30;

interface BackfillItem {
  timestamp: Date;
  campaignName: string | null;
  triggers: string[];
  skippedDetails: string[];
  rawMessage: string;
}

const ERROR_LINE_RE = /^([\d-]+\s[\d:]+):\s+(\[AdSubmit\].+(?:Google Ads 拒绝|创建失败|因政策违规拒绝).+)$/;
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})/;
const CAMPAIGN_NAME_RE = /[\u300c\u300e]([0-9A-Z]{3}-[A-Z0-9]+-[^\u300d\u300f]+-\d{4}-\d+)[\u300d\u300f]/;
const TRIGGER_RE = /[\u300c\u300e]([^\u300d\u300f]+)[\u300d\u300f]/g;
const SKIPPED_RE = /\u300c[^\u300d]+\u300d|\u300e[^\u300f]+\u300f/g;

async function parseLogFile(path: string, sinceTs: number): Promise<BackfillItem[]> {
  const content = await readFile(path, "utf-8").catch(() => "");
  if (!content) return [];

  const items: BackfillItem[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line.includes("Google Ads") && !line.includes("AdSubmit")) continue;
    // 只匹配拒登/RSA 拒绝/政策违规相关行
    if (!/Google Ads 拒绝|因政策违规拒绝|disapproved|TRADEMARK|POLICY_ERROR/i.test(line)) continue;

    const tsMatch = line.match(TIMESTAMP_RE);
    if (!tsMatch) continue;
    const ts = new Date(tsMatch[1]).getTime();
    if (ts < sinceTs) continue;

    const campMatch = line.match(CAMPAIGN_NAME_RE);
    const campaignName = campMatch ? campMatch[1] : null;

    // 抽出所有 「...」 之间的内容作为 triggers / details 候选
    const allBrackets: string[] = [];
    let m: RegExpExecArray | null;
    const re = new RegExp(SKIPPED_RE.source, "g");
    while ((m = re.exec(line)) !== null) {
      // 去掉 「」 / 『』 外壳
      const v = m[0].replace(/^[\u300c\u300e]|[\u300d\u300f]$/g, "");
      if (v && v !== campaignName) allBrackets.push(v);
    }

    // 区分 trigger 和 skippedDetails（这里粗略：纯负数 / 纯数字 / "关联资源" 之类归 skipped）
    const triggers: string[] = [];
    const skipped: string[] = [];
    for (const v of allBrackets) {
      if (/关联资源|致电扩展|RSA广告素材|关键词:|操作\[\d+\]/.test(v)) skipped.push(v);
      else if (/^-?\d+$/.test(v)) skipped.push(v); // -2/-3 之类级联
      else triggers.push(v);
    }

    items.push({
      timestamp: new Date(ts),
      campaignName,
      triggers,
      skippedDetails: skipped,
      rawMessage: line.slice(0, 2000),
    });
  }

  return items;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const daysArg = args.find((a) => a.startsWith("--days="));
  const days = daysArg ? parseInt(daysArg.split("=")[1], 10) : DEFAULT_DAYS;
  const sinceTs = Date.now() - days * 24 * 60 * 60 * 1000;

  console.log(`[D-041 backfill] 扫描 PM2 日志，回填近 ${days} 天拒登记录${dryRun ? "（dry-run，不写库）" : ""}`);

  let files: string[] = [];
  try {
    files = (await readdir(LOG_DIR)).filter((f) => f.startsWith("ad-automation-error") && f.endsWith(".log"));
  } catch (err) {
    console.error("[D-041 backfill] 无法读取日志目录（请在生产服务器跑此脚本）:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  console.log(`[D-041 backfill] 发现 ${files.length} 个错误日志文件: ${files.join(", ")}`);

  const allItems: BackfillItem[] = [];
  for (const f of files) {
    const items = await parseLogFile(join(LOG_DIR, f), sinceTs);
    if (items.length > 0) {
      console.log(`[D-041 backfill]   ${f}: 解析出 ${items.length} 条拒登记录`);
      allItems.push(...items);
    }
  }

  console.log(`[D-041 backfill] 共解析 ${allItems.length} 条拒登事件，开始映射到 policy 类别...`);

  if (dryRun) {
    const sample = allItems.slice(0, 5);
    console.log(`[D-041 backfill] dry-run 样本 5 条:`);
    for (const s of sample) {
      const category = mapToPolicyCategory({ message: s.rawMessage });
      console.log(`  - ${s.timestamp.toISOString()} | ${s.campaignName || "?"} | ${category.labelZh} | triggers=${s.triggers.slice(0, 3).join(",")}`);
    }
    console.log(`[D-041 backfill] dry-run 完成，未写库`);
    return;
  }

  let written = 0;
  let skipped = 0;
  for (const item of allItems) {
    const category = mapToPolicyCategory({ message: item.rawMessage });

    // 尝试关联到 campaigns 表（按 campaign_name 模糊匹配）
    let campaign_id: bigint | null = null;
    let user_id: bigint | null = null;
    let user_merchant_id: bigint | null = null;
    if (item.campaignName) {
      const camp = await prisma.campaigns.findFirst({
        where: { campaign_name: item.campaignName },
        select: { id: true, user_id: true, user_merchant_id: true },
      });
      if (camp) {
        campaign_id = camp.id;
        user_id = camp.user_id;
        user_merchant_id = camp.user_merchant_id;
      }
    }

    // 主要 trigger 作为 violating_text
    const violatingText = item.triggers[0] || null;

    // 去重：(campaign_id, policy_name, evidence_field) + 时间窗口
    const existing = await prisma.policy_violations.findFirst({
      where: {
        campaign_id,
        policy_name: "backfill_from_log",
        evidence_field: "backfill",
        submitted_at: {
          gte: new Date(item.timestamp.getTime() - 60 * 1000),
          lte: new Date(item.timestamp.getTime() + 60 * 1000),
        },
      },
      select: { id: true },
    });
    if (existing) { skipped++; continue; }

    await prisma.policy_violations.create({
      data: {
        campaign_id,
        user_id,
        user_merchant_id,
        campaign_name: item.campaignName,
        policy_category: category.category,
        policy_subcategory: category.subcategory,
        policy_label_zh: category.labelZh,
        policy_official_url: category.officialUrl,
        error_code: "BACKFILL_FROM_PM2_LOG",
        policy_name: "backfill_from_log",
        external_policy_name: null,
        external_policy_description: null,
        evidence_field: "backfill",
        evidence_index: -1,
        violating_text: violatingText,
        trigger_value: item.triggers.join(", ") || null,
        field_path: null,
        severity: category.severity,
        suggested_fix: category.suggestedFix,
        is_exemptible: 0,
        google_raw_error_json: item.rawMessage,
        message: item.rawMessage.slice(0, 500),
        submitted_at: item.timestamp,
      },
    });
    written++;
  }

  console.log(`[D-041 backfill] 完成：新增 ${written} 条 / 跳过 ${skipped} 条（已存在）`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[D-041 backfill] 错误:", err);
  await prisma.$disconnect();
  process.exit(1);
});
