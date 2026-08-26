import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * D-285 弹窗二：预算异常确认 + 一键调整
 *
 * 背景：D-266.1（2026-08-21）之前经 CRM 在非美元 MCC 建的系列，美元意图值被当
 * 账户币种 micros 下发，「$2」在人民币账户实际生效 ¥2（≈$0.28）。这批系列在
 * Google 上真的只有 ¥2/天在跑。
 *
 * GET  列出当前用户名下的异常系列（确认弹窗数据源）：
 *   - 只看已换新脚本的 MCC（system_configs mcc_script_budget_col_* 标记 true，
 *     此时 campaigns.daily_budget 已被 Sheet 全量回写 = Google 真值，比对才可信）
 *   - 非美元 MCC + 在投（ENABLED）+ 日预算折美元 ≤ $0.5（¥2 bug 特征值，正常 $2 不误伤）
 *   - 调整目标 = 用户默认广告设置的日预算（美元意图，缺省 $2）按当日汇率折账户币种
 * POST { campaign_ids } 用户确认后执行：
 *   - 服务端按 GET 同一套判定重算资格，只调仍然命中的（绝不信客户端传来的金额）
 *   - 写走 Google Ads API（updateCampaignBudget + Token 池），成功才回写库，全程记 operation_logs
 *
 * 数据通道：读全走库内标记与字段（源头是 Sheet 同步），零新增 API 读取；写走 API（正路）。
 */

const ANOMALY_USD_MAX = 0.5;
const TARGET_USD_MIN = 0.5;
const TARGET_USD_MAX = 500;

interface AnomalyRow {
  campaign_id: string;
  campaign_name: string;
  mcc_db_id: string;
  currency: string;
  /** 当前 Google 真值（账户币种 / 折美元） */
  current_account: number;
  current_usd: number;
  /** 调整目标（账户币种 / 美元意图） */
  target_account: number;
  target_usd: number;
}

async function computeAnomalies(userId: bigint): Promise<{ rows: AnomalyRow[]; targetUsd: number }> {
  // 1. 该用户的非美元 MCC，且已换新脚本（Budget 列标记 true）
  const mccs = await prisma.google_mcc_accounts.findMany({
    where: { user_id: userId, is_deleted: 0, currency: { not: "USD" } },
    select: { id: true, mcc_id: true, currency: true },
  });
  if (mccs.length === 0) return { rows: [], targetUsd: 2 };

  const flagKeys = mccs.map((m) => `mcc_script_budget_col_${m.id}`);
  const flags = await prisma.system_configs.findMany({
    where: { config_key: { in: flagKeys }, is_deleted: 0 },
    select: { config_key: true, config_value: true },
  });
  const flagByKey = new Map(flags.map((f) => [f.config_key, f.config_value]));
  const eligibleMccs = mccs.filter((m) => {
    const raw = flagByKey.get(`mcc_script_budget_col_${m.id}`);
    if (!raw) return false;
    try { return JSON.parse(raw)?.hasBudgetCol === true; } catch { return false; }
  });
  if (eligibleMccs.length === 0) return { rows: [], targetUsd: 2 };

  // 2. 调整目标 = 默认广告设置的日预算（美元意图，缺省 $2），钳制与 apply-actions 同区间
  const settings = await prisma.ad_default_settings.findFirst({
    where: { user_id: userId, is_deleted: 0 },
    select: { daily_budget: true },
  });
  const rawTarget = Number(settings?.daily_budget ?? 2);
  const targetUsd = Math.min(TARGET_USD_MAX, Math.max(TARGET_USD_MIN, rawTarget > 0 ? rawTarget : 2));

  // 3. 汇率（账户币种 → USD 乘数）；汇率不可用的 MCC 跳过——不确定不进清单（D-261 教训）
  const { getExchangeRate } = await import("@/lib/exchange-rate");
  const { todayCST } = await import("@/lib/date-utils");
  const today = todayCST();
  const rateByMccId = new Map<bigint, number>();
  for (const m of eligibleMccs) {
    const rate = await getExchangeRate(m.currency, today);
    if (rate > 0) rateByMccId.set(m.id, rate);
  }
  if (rateByMccId.size === 0) return { rows: [], targetUsd };

  // 4. 在投 + 日预算折美元 ≤ 阈值
  const campaigns = await prisma.campaigns.findMany({
    where: {
      user_id: userId,
      is_deleted: 0,
      google_status: "ENABLED",
      google_campaign_id: { not: null },
      mcc_id: { in: [...rateByMccId.keys()] },
    },
    select: { id: true, campaign_name: true, mcc_id: true, daily_budget: true },
  });

  const currencyByMccId = new Map(eligibleMccs.map((m) => [m.id, m.currency]));
  const rows: AnomalyRow[] = [];
  for (const c of campaigns) {
    const rate = rateByMccId.get(c.mcc_id!)!;
    const currentAccount = Number(c.daily_budget);
    const currentUsd = currentAccount * rate;
    if (!(currentUsd > 0) || currentUsd > ANOMALY_USD_MAX) continue;
    rows.push({
      campaign_id: String(c.id),
      campaign_name: c.campaign_name || String(c.id),
      mcc_db_id: String(c.mcc_id),
      currency: currencyByMccId.get(c.mcc_id!) || "",
      current_account: Number(currentAccount.toFixed(2)),
      current_usd: Number(currentUsd.toFixed(2)),
      target_account: Number((targetUsd / rate).toFixed(2)),
      target_usd: targetUsd,
    });
  }
  return { rows, targetUsd };
}

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);
  try {
    const { rows, targetUsd } = await computeAnomalies(BigInt(user.userId));
    return apiSuccess({ rows, target_usd: targetUsd });
  } catch (e) {
    return apiError(`预算异常检测失败: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);
  const userId = BigInt(user.userId);

  const body = await req.json().catch(() => ({}));
  const requested: string[] = Array.isArray(body?.campaign_ids) ? body.campaign_ids.map(String) : [];
  if (requested.length === 0) return apiError("缺少 campaign_ids", 400);

  try {
    // 服务端重算资格：只调「现在仍然命中异常判定」的系列，客户端 id 只做圈选
    const { rows } = await computeAnomalies(userId);
    const eligible = new Map(rows.map((r) => [r.campaign_id, r]));
    const targets = requested.filter((id) => eligible.has(id));
    if (targets.length === 0) return apiError("所选系列均不在可调整范围（可能已被同步纠正），请刷新后重试", 409);

    const mccIds = [...new Set(targets.map((id) => eligible.get(id)!.mcc_db_id))];
    const mccRows = await prisma.google_mcc_accounts.findMany({
      where: { id: { in: mccIds.map((v) => BigInt(v)) }, user_id: userId, is_deleted: 0 },
    });
    const mccById = new Map(mccRows.map((m) => [String(m.id), m]));

    const { updateCampaignBudget } = await import("@/lib/google-ads");
    const { poolHasCredentialFor } = await import("@/lib/google-ads/token-pool");
    const { getCidSuspendedError } = await import("@/lib/google-ads/cid-suspension");

    const results: Array<{ campaign_id: string; campaign_name: string; success: boolean; message: string }> = [];
    let succeeded = 0;

    for (const id of targets) {
      const row = eligible.get(id)!;
      const mcc = mccById.get(row.mcc_db_id);
      if (!mcc) {
        results.push({ campaign_id: id, campaign_name: row.campaign_name, success: false, message: "MCC 不存在" });
        continue;
      }
      if (!mcc.service_account_json && !(await poolHasCredentialFor(mcc.mcc_id))) {
        results.push({ campaign_id: id, campaign_name: row.campaign_name, success: false, message: "MCC 未配置凭证且 Token 池无配对 JSON" });
        continue;
      }
      const campaign = await prisma.campaigns.findFirst({
        where: { id: BigInt(id), user_id: userId, is_deleted: 0 },
        select: { id: true, customer_id: true, google_campaign_id: true, mcc_id: true },
      });
      if (!campaign?.google_campaign_id) {
        results.push({ campaign_id: id, campaign_name: row.campaign_name, success: false, message: "系列不存在或未关联 Google" });
        continue;
      }
      // D-248：被中止 CID 旗下广告禁止操作
      const suspendedMsg = await getCidSuspendedError(campaign.customer_id, campaign.mcc_id);
      if (suspendedMsg) {
        results.push({ campaign_id: id, campaign_name: row.campaign_name, success: false, message: suspendedMsg });
        continue;
      }

      const credentials = {
        mcc_id: mcc.mcc_id,
        developer_token: mcc.developer_token || "",
        service_account_json: mcc.service_account_json || "",
      };
      try {
        const r = await updateCampaignBudget(credentials, campaign.customer_id || "", campaign.google_campaign_id, row.target_account);
        if (r.success) {
          await prisma.campaigns.update({ where: { id: campaign.id }, data: { daily_budget: row.target_account } });
          succeeded++;
          results.push({
            campaign_id: id, campaign_name: row.campaign_name, success: true,
            message: `$${row.current_usd} → $${row.target_usd}（${row.target_account} ${row.currency}）`,
          });
        } else {
          results.push({ campaign_id: id, campaign_name: row.campaign_name, success: false, message: r.message });
        }
      } catch (e) {
        results.push({ campaign_id: id, campaign_name: row.campaign_name, success: false, message: e instanceof Error ? e.message : String(e) });
      }
    }

    // 审计日志（口径同 apply-actions：一次请求一条，detail 截断防超长）
    try {
      await prisma.operation_logs.create({
        data: {
          user_id: userId,
          username: user.username || String(user.userId),
          action: "budget_fix_apply",
          target_type: "campaign_batch",
          target_id: targets.join(",").slice(0, 64),
          detail: JSON.stringify({ results }).slice(0, 4000),
        },
      });
    } catch { /* 审计失败不阻塞 */ }

    return apiSuccess({ results, succeeded, failed: results.length - succeeded });
  } catch (e) {
    return apiError(`一键调整失败: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
}
