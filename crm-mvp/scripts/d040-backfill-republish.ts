/**
 * D-040 v2 — 全业务 republish historical cost backfill (一次性脚本)
 *
 * 背景：
 *   republish/route.ts 重发流程会清空 campaigns.google_campaign_id，
 *   旧 gcid 在 GAds 后台变成 REMOVED 还存在。但 cron status-sync 的 GAQL
 *   `SELECT FROM campaign` 默认隐式过滤 REMOVED → CRM 永久丢失旧 gcid 的
 *   cost 历史 → 与 GAds 后台对账长期错配（07 反馈 BRUNT $51 vs $53）。
 *
 * 本脚本一次性补救：
 *   1. 遍历每个 user → 每个 MCC → 每个 CID
 *   2. GAQL 显式 `WHERE campaign.status = 'REMOVED'` 拉所有 REMOVED 历史
 *   3. 按 (campaign_name + customer_id) 匹配 CRM campaigns 表里
 *      current gcid ≠ GAds REMOVED gcid 的记录
 *   4. 把 GAds REMOVED gcid 添加到该 campaign 的 previous_gcids 数组
 *   5. 把 GAds REMOVED gcid 的每日 cost/clicks/impressions
 *      通过 ads_daily_stats.upsert(where:{campaign_id_date:{...}}) 累加
 *      到该 campaign 的 ads_daily_stats（不新建 campaign 记录）
 *   6. 输出 backfill 报告
 *
 * 跑法（生产服务器）：
 *   ssh ubuntu@43.156.142.141
 *   cd /home/ubuntu/Google-Data-Analysis/crm-mvp
 *   npx tsx scripts/d040-backfill-republish.ts                # dry-run
 *   CONFIRM=1 npx tsx scripts/d040-backfill-republish.ts      # 实际写入 DB
 *
 * 风险：会修改 campaigns.previous_gcids + ads_daily_stats（追加 cost 数据），
 *      不会创建新 campaign，不会删除任何数据。脚本 dry-run 优先。
 */

import prisma from "../src/lib/prisma";

const DRY_RUN = process.env.CONFIRM !== "1";
const SINCE_DATE = process.env.SINCE || "2026-01-01"; // GAds REMOVED 历史回溯起点
const ONLY_USER = process.env.USER_ID ? BigInt(process.env.USER_ID) : null;

interface BackfillStats {
  users_scanned: number;
  mccs_scanned: number;
  cids_scanned: number;
  gads_removed_found: number;
  matched_to_existing: number;
  added_to_previous_gcids: number;
  ads_stats_rows_upserted: number;
  errors: string[];
}

interface GAdsRow {
  campaign: { id?: string | number; name?: string; status?: string };
  segments?: { date?: string };
  metrics?: { costMicros?: string | number; clicks?: string | number; impressions?: string | number };
  customer?: { id?: string | number };
}

function microsToDollars(micros: number): number {
  return Math.round((micros / 1_000_000) * 100) / 100;
}

async function main() {
  console.log("=".repeat(80));
  console.log("D-040 v2 — 全业务 republish historical cost backfill");
  console.log("DRY_RUN =", DRY_RUN, DRY_RUN ? "(set CONFIRM=1 to write)" : "");
  console.log("SINCE_DATE =", SINCE_DATE);
  console.log("ONLY_USER =", ONLY_USER || "(全部 user)");
  console.log("=".repeat(80));

  const stats: BackfillStats = {
    users_scanned: 0,
    mccs_scanned: 0,
    cids_scanned: 0,
    gads_removed_found: 0,
    matched_to_existing: 0,
    added_to_previous_gcids: 0,
    ads_stats_rows_upserted: 0,
    errors: [],
  };

  const { queryGoogleAds } = await import("../src/lib/google-ads/client");

  const users = await prisma.users.findMany({
    where: { is_deleted: 0, ...(ONLY_USER ? { id: ONLY_USER } : {}) },
    select: { id: true, username: true },
  });

  for (const user of users) {
    const userId = user.id;
    stats.users_scanned++;
    console.log(`\n── user_id=${userId} (${user.username}) ──`);

    const mccs = await prisma.google_mcc_accounts.findMany({
      where: { user_id: userId, is_deleted: 0, is_active: 1 },
    });

    for (const mcc of mccs) {
      if (!mcc.developer_token || !mcc.service_account_json) {
        console.log(`  [Skip mcc=${mcc.mcc_id}] 凭证缺失`);
        continue;
      }
      stats.mccs_scanned++;
      console.log(`  ── mcc id=${mcc.id} mcc_id=${mcc.mcc_id} (${mcc.mcc_name}) ──`);

      const credentials = {
        mcc_id: mcc.mcc_id,
        developer_token: mcc.developer_token,
        service_account_json: mcc.service_account_json,
      };

      // 取 CID 列表（同 status-sync 逻辑）
      const cids = await prisma.mcc_cid_accounts.findMany({
        where: { mcc_account_id: mcc.id, is_deleted: 0, status: "active" },
      });
      let customerIds = cids.map((c) => c.customer_id);
      if (customerIds.length === 0) {
        const campaignCids = await prisma.campaigns.findMany({
          where: { user_id: userId, mcc_id: mcc.id, is_deleted: 0, customer_id: { not: null } },
          select: { customer_id: true },
          distinct: ["customer_id"],
        });
        customerIds = campaignCids.map((c) => c.customer_id!).filter(Boolean);
      }
      if (customerIds.length === 0) {
        console.log("    [Skip] 没有 CID");
        continue;
      }

      // 加载本 MCC 下所有现有 campaigns（用于 (name+cid) 匹配 + previous_gcids 反查）
      const existingCampaigns = await prisma.campaigns.findMany({
        where: { user_id: userId, mcc_id: mcc.id, is_deleted: 0 },
        select: { id: true, google_campaign_id: true, campaign_name: true, customer_id: true, previous_gcids: true },
      });
      // (campaign_name + customer_id) → campaigns[]（同名同 CID 可能多条）
      const nameCidMap = new Map<string, typeof existingCampaigns>();
      for (const c of existingCampaigns) {
        const key = `${c.campaign_name}|${(c.customer_id || "").replace(/-/g, "")}`;
        if (!nameCidMap.has(key)) nameCidMap.set(key, []);
        nameCidMap.get(key)!.push(c);
      }

      // 对每个 CID 跑 GAQL 拉 REMOVED + daily metrics（注意：GAQL 需要 cost/clicks/impressions 跟 segments.date 一起）
      for (const cid of customerIds) {
        stats.cids_scanned++;
        try {
          const removedRows = await queryGoogleAds(credentials, cid, `
            SELECT
              campaign.id, campaign.name, campaign.status,
              customer.id,
              segments.date,
              metrics.cost_micros, metrics.clicks, metrics.impressions
            FROM campaign
            WHERE campaign.status = 'REMOVED'
              AND segments.date >= '${SINCE_DATE}'
          `) as GAdsRow[];

          if (removedRows.length === 0) continue;

          // 按 gcid 分组，每组一个 REMOVED campaign 对应若干日期 stats
          const byGcid = new Map<string, { name: string; cid: string; days: { date: string; cost: number; clicks: number; impressions: number }[] }>();
          for (const r of removedRows) {
            const gid = String(r.campaign?.id ?? "");
            const name = String(r.campaign?.name ?? "");
            const rawCid = String(r.customer?.id ?? cid).replace(/-/g, "");
            const date = String(r.segments?.date ?? "");
            const costMicros = Number(r.metrics?.costMicros ?? 0);
            const clicks = Number(r.metrics?.clicks ?? 0);
            const impressions = Number(r.metrics?.impressions ?? 0);
            if (!gid || !date) continue;
            if (!byGcid.has(gid)) byGcid.set(gid, { name, cid: rawCid, days: [] });
            byGcid.get(gid)!.days.push({ date, cost: microsToDollars(costMicros), clicks, impressions });
          }

          stats.gads_removed_found += byGcid.size;

          for (const [oldGcid, info] of byGcid) {
            const key = `${info.name}|${info.cid}`;
            const candidates = nameCidMap.get(key) || [];
            // 排除 current gcid 等于 oldGcid 的 candidate（同 campaign 还在跑就不算"被重发"）
            const targets = candidates.filter((c) => c.google_campaign_id !== oldGcid);
            if (targets.length === 0) {
              // 没有"重发后"的 current 记录承接它，跳过（孤立 REMOVED）
              continue;
            }
            // 选择最新 (id 最大) 的一条 candidate 作为承接 campaign
            targets.sort((a, b) => Number(b.id) - Number(a.id));
            const target = targets[0];
            stats.matched_to_existing++;

            const existingPrev = Array.isArray(target.previous_gcids) ? (target.previous_gcids as string[]) : [];
            const needsAddPrev = !existingPrev.includes(oldGcid);

            console.log(
              `    [Match] REMOVED gcid=${oldGcid} name="${info.name}" cid=${info.cid}`
              + ` → campaign id=${target.id} current_gcid=${target.google_campaign_id}`
              + ` days=${info.days.length} needsAddPrev=${needsAddPrev}`
            );

            if (DRY_RUN) continue;

            // 1) push 旧 gcid 到 previous_gcids（去重）
            if (needsAddPrev) {
              await prisma.campaigns.update({
                where: { id: target.id },
                data: { previous_gcids: [...existingPrev, oldGcid] },
              });
              stats.added_to_previous_gcids++;
            }

            // 2) 把每日 cost/clicks/impressions 累加（upsert）到该 campaign 的 ads_daily_stats
            for (const d of info.days) {
              try {
                // 直接覆盖（旧 gcid 的 stats 是新的输入数据；若 (campaign_id, date) 已存在
                // 说明 stats 已含 current 时期数据，需累加旧 gcid 时期的）
                // 用 upsert + update 增量加，避免覆盖 current 数据
                const existing = await prisma.ads_daily_stats.findUnique({
                  where: { campaign_id_date: { campaign_id: target.id, date: new Date(d.date) } },
                });
                if (existing) {
                  // 累加：cost/clicks/impressions += old gcid 在该日的数据
                  await prisma.ads_daily_stats.update({
                    where: { id: existing.id },
                    data: {
                      cost: Number(existing.cost) + d.cost,
                      clicks: Number(existing.clicks || 0) + d.clicks,
                      impressions: Number(existing.impressions || 0) + d.impressions,
                    },
                  });
                } else {
                  await prisma.ads_daily_stats.create({
                    data: {
                      user_id: userId,
                      user_merchant_id: BigInt(0),
                      campaign_id: target.id,
                      date: new Date(d.date),
                      cost: d.cost,
                      clicks: d.clicks,
                      impressions: d.impressions,
                      data_source: "api" as const,
                    },
                  });
                }
                stats.ads_stats_rows_upserted++;
              } catch (e) {
                stats.errors.push(`stats upsert fail campaign=${target.id} date=${d.date}: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // 权限错误等可忽略，记录后继续
          if (msg.includes("PERMISSION_DENIED") || msg.includes("CUSTOMER_NOT_ENABLED")) {
            console.log(`    [Skip CID=${cid}] 权限错误`);
          } else {
            stats.errors.push(`cid=${cid}: ${msg}`);
            console.log(`    [Error CID=${cid}] ${msg.slice(0, 100)}`);
          }
        }
      }
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("Backfill Summary:");
  console.log(JSON.stringify(stats, null, 2));
  console.log("=".repeat(80));

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  prisma.$disconnect();
  process.exit(1);
});
