import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

/**
 * POST /api/user/data-center/update-campaign
 * 通过 Google Ads API 修改预算或 CPC - Service Account 认证
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { campaign_id, field, value } = await req.json();
  if (!campaign_id) return apiError("缺少 campaign_id", 400);
  if (!field || !["budget", "max_cpc", "name"].includes(field)) return apiError("field 必须是 budget、max_cpc 或 name", 400);
  // name 的 value 是字符串，走自己的校验；budget/max_cpc 仍是非负数
  if (field === "name") {
    if (typeof value !== "string" || !value.trim()) return apiError("广告系列名称不能为空", 400);
  } else if (value === undefined || value === null || value < 0) {
    return apiError("value 必须是非负数", 400);
  }

  const userId = BigInt(user.userId);

  const campaign = await prisma.campaigns.findFirst({
    where: { id: BigInt(campaign_id), user_id: userId, is_deleted: 0 },
  });
  if (!campaign) return apiError("广告系列不存在", 404);
  if (!campaign.google_campaign_id) return apiError("广告系列未关联 Google Ads", 400);
  if (!campaign.mcc_id) return apiError("广告系列未关联 MCC 账户", 400);
  // D-248：被中止 CID 旗下广告禁止一切操作（前端灰化 + 服务端拦截双层）
  {
    const { getCidSuspendedError } = await import("@/lib/google-ads/cid-suspension");
    const suspendedMsg = await getCidSuspendedError(campaign.customer_id, campaign.mcc_id);
    if (suspendedMsg) return apiError(suspendedMsg, 403);
  }

  const mcc = await prisma.google_mcc_accounts.findFirst({
    where: { id: campaign.mcc_id, user_id: userId, is_deleted: 0 },
  });
  if (!mcc) return apiError("广告系列关联的 MCC 账户不存在", 404);
  {
    const { poolHasCredentialFor } = await import("@/lib/google-ads/token-pool");
    if (!mcc.service_account_json && !(await poolHasCredentialFor(mcc.mcc_id))) {
      return apiError("MCC 未配置服务账号凭证，且组 Token 池中无配对的 Service Account JSON（请组长在「团队设置 → Token 池」配置）", 400);
    }
  }

  try {
    const { updateCampaignBudget, updateCampaignMaxCpc } = await import("@/lib/google-ads");
    const credentials = { mcc_id: mcc.mcc_id, developer_token: mcc.developer_token || "", service_account_json: mcc.service_account_json || "" };

    // ── D-339：CRM 内改名 → 写回 Google → 按新名重排归属 ──
    // 名称即归属（07 规则：平台段的数字是该平台第几个联盟账号）。所以改名必须
    // 与 reassignByConfirmedIndex 绑在一起：只改名不重排，会留下「名字变了、
    // 归属和链接键没动」的半坏状态——比名实不符更难查（见 D-223 告警）。
    if (field === "name") {
      return await handleRename({ campaign, credentials, userId, newName: value.trim(), user, req });
    }

    // D-266 批一：前端输入是美元意图值，按当日汇率换算成账户币种再下发/入库。
    // 汇率不可用时直接拒绝——严禁把美元数字当账户币种发出去（D-265① 病根）。
    const { usdToAccountCurrency } = await import("@/lib/exchange-rate");
    const { todayCST } = await import("@/lib/date-utils");
    const currency = (mcc.currency || "USD").toUpperCase();
    const conv = await usdToAccountCurrency(currency, value, todayCST());
    if (!conv) return apiError(`${currency} 汇率不可用，为避免金额语义错误已中止修改，请稍后重试`, 503);
    const accountValue = Number(conv.value.toFixed(field === "budget" ? 2 : 4));
    const convNote = currency === "USD" ? "" : `（$${value} × 汇率 → ${accountValue} ${currency}）`;

    let result: { success: boolean; message: string };

    if (field === "budget") {
      result = await updateCampaignBudget(credentials, campaign.customer_id || "", campaign.google_campaign_id, accountValue);
      if (result.success) {
        await prisma.campaigns.update({ where: { id: campaign.id }, data: { daily_budget: accountValue } });
      }
    } else {
      result = await updateCampaignMaxCpc(credentials, campaign.customer_id || "", campaign.google_campaign_id, accountValue);
      if (result.success) {
        await prisma.campaigns.update({ where: { id: campaign.id }, data: { max_cpc_limit: accountValue } });
      }
    }

    if (!result.success) return apiError(result.message, 500);

    const updated = await prisma.campaigns.findUnique({ where: { id: campaign.id } });
    return apiSuccess(serializeData({ campaign: updated, message: `${field === "budget" ? "预算" : "最高出价"}已更新为 $${value}${convNote}` }));
  } catch (err) {
    return apiError(`修改失败: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
}

type RenameArgs = {
  campaign: { id: bigint; campaign_name: string | null; customer_id: string | null; google_campaign_id: string | null };
  credentials: { mcc_id: string; developer_token: string; service_account_json: string };
  userId: bigint;
  newName: string;
  user: { userId: string | number; username?: string };
  req: NextRequest;
};

/**
 * 改名主流程。顺序是刻意的：**谷歌成功才算成功**。
 * 谷歌失败即返回，CRM 一个字段都不动，两边永不出现名字不一致。
 */
async function handleRename(a: RenameArgs) {
  const { campaign, userId, newName } = a;
  const oldName = campaign.campaign_name || "";
  if (newName === oldName) return apiError("新名称与当前名称相同", 400);
  if (newName.length > 255) return apiError("广告系列名称不得超过 255 字符", 400);

  const { parseCampaignNameFull } = await import("@/lib/campaign-merchant-link");
  const { isValidPlatformCode } = await import("@/lib/constants");
  const parsed = parseCampaignNameFull(newName);
  if (!parsed) {
    return apiError("名称格式不合规。要求：序号-平台-商家-国家-月日-MID，例 1347-MUI2-VSL3-US-0821-8005543", 400);
  }
  if (!isValidPlatformCode(parsed.platform)) {
    return apiError(`平台代号「${parsed.platform}」不是系统已知平台`, 400);
  }

  // 目标账号位次必须有存活连接，否则 reassign 会「映射不到就跳过」，
  // 结果名字改了归属没动 —— 必须在写谷歌之前拦掉。
  const { normalizePlatformCode } = await import("@/lib/constants");
  const wantIdx = parsed.accountIndex ?? 1;
  const liveConns = await prisma.platform_connections.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true, platform: true, account_index: true, account_name: true },
  });
  const target = liveConns.find(
    (c) => normalizePlatformCode(c.platform) === parsed.platform && (c.account_index ?? 1) === wantIdx,
  );
  if (!target) {
    return apiError(
      `名称指向 ${parsed.platform}${wantIdx} ，但你名下没有该平台第 ${wantIdx} 个联盟账号。` +
        `请先在「设置 → 联盟账号序号」确认序号，或改用已存在的账号位次。`,
      400,
    );
  }

  return await renameStep2({ ...a, parsed, target });
}

async function renameStep2(
  a: RenameArgs & {
    parsed: { platform: string; accountIndex: number | null };
    target: { id: bigint; platform: string; account_index: number | null; account_name: string };
  },
) {
  const { campaign, credentials, userId, newName, parsed, target, user, req } = a;
  const oldName = campaign.campaign_name || "";
  const customerId = campaign.customer_id || "";
  const { queryGoogleAds, renameCampaign } = await import("@/lib/google-ads");

  // 谷歌侧同账户内系列名必须唯一（含已暂停），重名会报 DuplicateCampaignName。
  // 先查掉，别等 API 报错——错误信息对用户不可读。
  const esc = newName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const dup = await queryGoogleAds(
    credentials,
    customerId,
    `SELECT campaign.id FROM campaign
     WHERE campaign.name = '${esc}' AND campaign.status != 'REMOVED'`,
  );
  if (dup.length > 0) return apiError(`Google Ads 账户内已存在同名广告系列「${newName}」`, 409);

  const res = await renameCampaign(credentials, customerId, campaign.google_campaign_id!, newName);
  if (!res.success) return apiError(res.message, 500);

  // 谷歌已成功 —— 从这里起 CRM 必须跟上。
  await prisma.campaigns.update({
    where: { id: campaign.id },
    data: { campaign_name: newName, last_google_sync_at: new Date() },
  });

  // 按新名重排归属 + 迁移链接键（D-180）。这一步失败不回滚谷歌改名：
  // 名字已经是新的，回滚反而更乱；如实告知并留告警让人重试（换链接页有纠正按钮）。
  let reassignNote = "";
  try {
    const { reassignByConfirmedIndex } = await import("@/lib/account-index-reassign");
    const r = await reassignByConfirmedIndex(userId, parsed.platform, false, { onlyCampaignIds: [campaign.id] });
    const moved = r.campaignsReassigned.length;
    const migrated = r.linkMigrations.filter((m) => m.migrated).length;
    reassignNote = moved > 0
      ? `，归属已重排到 ${target.account_name}${migrated > 0 ? `，迁移链接键 ${migrated} 条` : ""}`
      : `，归属无需变动`;
  } catch (e) {
    reassignNote = `，但归属重排失败（${e instanceof Error ? e.message.slice(0, 80) : String(e)}），请到「换链接」页点「按系列名纠正归属」重试`;
  }

  const { logOperation } = await import("@/lib/operation-log");
  await logOperation({
    userId: user.userId,
    username: user.username || "",
    action: "rename_campaign",
    targetType: "campaign",
    targetId: campaign.id,
    detail: { oldName, newName, platform: parsed.platform, accountIndex: parsed.accountIndex ?? 1, targetConnId: target.id.toString() },
    req,
  });

  const updated = await prisma.campaigns.findUnique({ where: { id: campaign.id } });
  return apiSuccess(serializeData({ campaign: updated, message: `广告系列已重命名为 ${newName}${reassignNote}` }));
}
