import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

/**
 * PATCH /api/user/ad-creation/update-final-url
 * 更新广告素材的落地页 URL（final_url），同时可更新商家的 tracking_link / campaign_link，
 * 以及广告系列的广告语言（language_id）
 *
 * Body:
 *   campaign_id     - 广告系列 ID（必填）
 *   final_url       - 广告落地页 URL（与 language_id 至少填一个）
 *   affiliate_url   - 联盟跟踪链接（选填，保存到 user_merchants.tracking_link + campaign_link）
 *   language_id     - 广告语言 code（选填，如 "nl", "fr"，由爬虫自动检测或用户手动设置）
 */
export async function PATCH(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return apiError("请求体解析失败", 400);
  }

  const { campaign_id, final_url, affiliate_url, language_id, final_url_suffix } = body as {
    campaign_id?: string;
    final_url?: string;
    affiliate_url?: string;
    language_id?: string;
    final_url_suffix?: string;
  };

  if (!campaign_id) return apiError("缺少 campaign_id");

  const hasUrl = final_url && String(final_url).trim();
  const hasLang = language_id && String(language_id).trim();
  const hasSuffix = final_url_suffix !== undefined;
  if (!hasUrl && !hasLang && !hasSuffix) return apiError("final_url、language_id、final_url_suffix 至少填一个");

  let fixedUrl = hasUrl ? (final_url as string).trim() : "";
  if (fixedUrl) {
    if (!fixedUrl.startsWith("http")) return apiError("落地页 URL 必须以 http:// 或 https:// 开头");
    if (fixedUrl.startsWith("http://")) fixedUrl = fixedUrl.replace("http://", "https://");
  }

  const userId = BigInt(user.userId);

  // 验证 campaign 归属
  const campaign = await prisma.campaigns.findFirst({
    where: { id: BigInt(campaign_id), user_id: userId, is_deleted: 0 },
    // D-365：补 google/mcc 三字段——已提交的系列保存后缀要真推 Google，不能只写库
    select: {
      id: true, user_merchant_id: true,
      google_campaign_id: true, customer_id: true, mcc_id: true,
    },
  });
  if (!campaign) return apiError("广告系列不存在", 404);

  // 查找广告组和广告素材
  const adGroup = await prisma.ad_groups.findFirst({
    where: { campaign_id: campaign.id, is_deleted: 0 },
    select: { id: true },
  });
  if (!adGroup) return apiError("广告系列正在初始化，请稍等 1 分钟后刷新页面再试");

  const adCreative = await prisma.ad_creatives.findFirst({
    where: { ad_group_id: adGroup.id, is_deleted: 0 },
    select: { id: true },
  });
  if (!adCreative) return apiError("广告素材不存在");

  const updates: Promise<unknown>[] = [];

  // 更新 final_url —— LAND-01：用户手动设定落地页即加锁，后续生成/提交不再自动改写覆盖
  if (fixedUrl) {
    updates.push(prisma.ad_creatives.update({
      where: { id: adCreative.id },
      data: { final_url: fixedUrl, final_url_locked: 1 },
    }));
  }

  // 更新广告语言（保存到 campaigns.language_id）
  if (language_id && typeof language_id === "string") {
    updates.push(prisma.campaigns.update({
      where: { id: campaign.id },
      data: { language_id: language_id.trim() },
    }));
  }

  // 更新最终到达网址后缀（保存到 campaigns.final_url_suffix）
  // D-365：suffixVal 提到块外——保存成功后要用它推 Google
  let suffixVal: string | null = null;
  if (hasSuffix) {
    // D-157：保存即归一化——剥掉前导 '?'/'&'（Google Ads final_url_suffix 不能以其开头）+ 去首尾空白与尾部多余 &
    suffixVal = typeof final_url_suffix === "string"
      ? (final_url_suffix.trim().replace(/^[?&\s]+/, "").replace(/[?&\s]+$/, "").trim() || null)
      : null;
    // 后缀必须是 query 参数串（k=v&k2=v2），不能是整条链接——历史上有员工把 linkhaitao/partnermatic
    // 整条追踪链接贴进来，Google 端拼出 `落地页?https://...` 的废链接，换链/刷点击全部失效。
    // D-354：只按「串的开头是不是 URL」判，不再 includes("://")——
    // 参数值里带 URL（utm_campaign=https://...，Rewardoo/soicos 的正常写法）是合法后缀，之前被误杀导致存不进去。
    const { looksLikeWholeTrackingLink } = await import("@/lib/affiliate-link-resolver");
    if (suffixVal && looksLikeWholeTrackingLink(suffixVal)) {
      return apiError("最终到达网址后缀必须是追踪参数串（如 utm_source=xx&clickid=yy），不能填整条跟踪链接。整条链接请填在上方「联盟跟踪链接」输入框");
    }
    updates.push(prisma.campaigns.update({
      where: { id: campaign.id },
      data: { final_url_suffix: suffixVal || null } as any,
    }));
  }

  // 若提供了联盟跟踪链接，同步更新商家记录
  if (affiliate_url && typeof affiliate_url === "string" && affiliate_url.startsWith("http")) {
    updates.push(prisma.user_merchants.update({
      where: { id: campaign.user_merchant_id },
      data: {
        tracking_link: affiliate_url,
        campaign_link: affiliate_url,
      },
    }));
  }

  await Promise.all(updates);

  // ═════════════════════════════════════════════════════════════════
  // D-365：已提交到 Google 的系列，保存后缀必须真的推上去。
  //   原先本路由只写库，而 Google 侧的 final_url_suffix 只在 submit 创建系列那一刻写一次
  //   （submit/route.ts:1297）。于是广告建成之后，这里保存多少次都只是改库，界面还回
  //   「后缀已保存」——员工以为生效了，实际 Google 上一直是空的。
  //   未提交的系列（google_campaign_id 为空）不需要推，submit 时会带上。
  //   推送失败不回滚库值：库里存着是对的，换链脚本下一轮也会按库值覆盖；只把失败如实回报。
  // ═════════════════════════════════════════════════════════════════
  let suffixPushed: boolean | null = null;
  let suffixPushMessage = "";
  if (hasSuffix && campaign.google_campaign_id) {
    if (!campaign.mcc_id || !campaign.customer_id) {
      suffixPushed = false;
      suffixPushMessage = "该系列未关联 MCC / CID，无法推送到 Google Ads";
    } else {
      const mcc = await prisma.google_mcc_accounts.findFirst({
        where: { id: campaign.mcc_id, user_id: userId, is_deleted: 0 },
        select: { mcc_id: true, developer_token: true, service_account_json: true },
      });
      // D-248：被中止 CID 旗下广告禁止一切操作（与 apply-actions 同一道闸）
      const { getCidSuspendedError } = await import("@/lib/google-ads/cid-suspension");
      const suspendedMsg = await getCidSuspendedError(campaign.customer_id, campaign.mcc_id);
      // 凭据缺失要先说清楚，否则 mutate 只会抛一句看不懂的底层错（与 apply-actions 同一道闸）
      const { poolHasCredentialFor } = await import("@/lib/google-ads/token-pool");
      const hasCred = !!mcc && (!!mcc.service_account_json || (await poolHasCredentialFor(mcc.mcc_id)));
      if (!mcc) {
        suffixPushed = false;
        suffixPushMessage = "广告系列关联的 MCC 账户不存在";
      } else if (suspendedMsg) {
        suffixPushed = false;
        suffixPushMessage = suspendedMsg;
      } else if (!hasCred) {
        suffixPushed = false;
        suffixPushMessage = "MCC 未配置服务账号凭证，且组 Token 池中无配对的 Service Account JSON";
      } else {
        try {
          const { updateCampaignFinalUrlSuffix } = await import("@/lib/google-ads");
          const r = await updateCampaignFinalUrlSuffix(
            {
              mcc_id: mcc.mcc_id,
              developer_token: mcc.developer_token || "",
              service_account_json: mcc.service_account_json || "",
            },
            campaign.customer_id,
            campaign.google_campaign_id,
            suffixVal || "",
          );
          suffixPushed = r.success;
          suffixPushMessage = r.message;
          console.warn(
            `[UpdateFinalUrl] D-365 后缀推送 Google campaign=${campaign.id} ` +
              `google_id=${campaign.google_campaign_id} ok=${r.success} ${r.message}`,
          );
        } catch (e) {
          suffixPushed = false;
          suffixPushMessage = e instanceof Error ? e.message : String(e);
          console.warn("[UpdateFinalUrl] D-365 后缀推送异常:", suffixPushMessage);
        }
      }
    }
  }

  // 已提交系列推送失败时必须让员工看见，不能再静默回「已更新」
  if (suffixPushed === false) {
    const msg = `后缀已存入 CRM，但推送到 Google Ads 失败：${suffixPushMessage}。请稍后重试，或等换链脚本下一轮自动下发。`;
    return apiSuccess({ suffix_pushed: false, suffix_push_message: suffixPushMessage, message: msg }, msg);
  }

  const okMsg = suffixPushed === true ? "已更新，并已同步到 Google Ads" : "已更新";
  return apiSuccess(
    suffixPushed === true ? { suffix_pushed: true, message: okMsg } : { message: okMsg },
    okMsg,
  );
}
