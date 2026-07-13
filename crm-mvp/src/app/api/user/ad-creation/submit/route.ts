import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { getAdMarketConfig } from "@/lib/ad-market";
import { sanitizeAdText, isSitelinkLocaleCompatible, isBadSitelinkUrl } from "@/lib/crawl-pipeline";
import { isLowValueSitelink } from "@/lib/sitelink-filter";
import { tryValidateUrl } from "@/lib/url-validator";
import { fitAdTextBatch, fitAdTextSync } from "@/lib/ad-text-fit";
import { collectAiRuleViolations, normalizeAiRuleProfile, getActivePersona, includesForbiddenTerm, autoRewriteForbiddenTerms } from "@/lib/ai-rule-profile";
import { callAiWithFallback } from "@/lib/ai-service";
import { extractJsonFromAi } from "@/lib/crawl-pipeline";
import { isPolicyRiskKeyword } from "@/lib/keyword-optimizer";
import { mutateGoogleAds, dollarsToMicros, queryGoogleAds, parseGoogleAdsErrors, formatGoogleAdsErrorMessage, isOperationNotPermittedError } from "@/lib/google-ads";
import type { GoogleAdsViolation } from "@/lib/google-ads";
import { parsePolicyError, logPolicyViolations, rewriteAdCopyForPolicy, type ParsedPolicyError } from "@/lib/policy-hub";
import { checkReachability, isHardUnreachable } from "@/lib/intellicenter/ad-creation";
import { assignFormalCampaignNameBeforeSubmit, resolvePlatformLabel } from "@/lib/campaign-naming";
import { createOrReuseSubmitJob, enqueueSubmitJob } from "@/lib/submit-runner";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

const AD_IMAGE_DIR = path.join(process.cwd(), ".uploads", "ad-images");

async function loadImageAsBase64(imageUrl: string): Promise<{ data: string; name: string } | null> {
  try {
    if (imageUrl.startsWith("/api/user/ad-creation/upload-image/")) {
      const filename = imageUrl.split("/").pop();
      if (!filename) return null;
      const filePath = path.join(AD_IMAGE_DIR, filename);
      if (!existsSync(filePath)) return null;
      const buffer = await readFile(filePath);
      if (buffer.length > 5 * 1024 * 1024) return null;
      return { data: buffer.toString("base64"), name: filename };
    }
    if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
      const resp = await fetch(imageUrl, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) return null;
      const buffer = Buffer.from(await resp.arrayBuffer());
      if (buffer.length > 5 * 1024 * 1024) return null;
      const urlName = imageUrl.split("/").pop()?.split("?")[0] || "image";
      return { data: buffer.toString("base64"), name: urlName.slice(0, 50) };
    }
    return null;
  } catch (err) {
    console.warn("[AdSubmit] 图片加载失败:", imageUrl, err);
    return null;
  }
}

/**
 * POST /api/user/ad-creation/submit
 *
 * 后台任务版：轻校验 campaign 归属后 createOrReuseSubmitJob 建/复用 job 并入队，立即返回
 * { async:true, job_id }。前端随后短轮询 /submit-status 读结果。彻底绕开 Cloudflare ~100s
 * 边缘超时（合规返工 + 图片 + Google mutate 单次可 >2min，旧同步链路会被 CF 断成 HTML 524，
 * 前端按 JSON 解析报 Unexpected token '<'）。
 *
 * 灰度回滚：SUBMIT_ASYNC_OFF=1 → 同步执行 runSubmitCore（旧行为）。
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return apiError("请求体格式错误");
  }
  const userId = BigInt(user.userId);

  // 灰度回滚：同步执行（旧行为），前端拿到最终结果，无 job_id。
  if (process.env.SUBMIT_ASYNC_OFF === "1") {
    return runSubmitCore(userId, body);
  }

  // 轻量校验：避免给非法请求建 job（完整校验/执行在 runSubmitCore 内）。
  const campaignId = body?.campaign_id;
  if (!campaignId) return apiError("缺少 campaign_id");
  const campaign = await prisma.campaigns.findFirst({
    where: { id: BigInt(campaignId), user_id: userId, is_deleted: 0 },
    select: { id: true, google_campaign_id: true },
  });
  if (!campaign) return apiError("广告系列不存在", 404);
  if (campaign.google_campaign_id) return apiError("该广告系列已提交到 Google Ads");

  const job = await createOrReuseSubmitJob({ campaignId: campaign.id, userId, payload: body });
  enqueueSubmitJob(job.id);
  return apiSuccess({ async: true, job_id: job.id.toString(), reused: job.reused });
}

/**
 * 提交广告到 Google Ads（REST API 批量 Mutate）核心逻辑。
 * 单次请求创建 Budget + Campaign + AdGroup + RSA Ad + Keywords + Extensions。
 * 由 submit-runner 在后台调用（或 SUBMIT_ASYNC_OFF 时由 POST 同步调用），返回标准 Response。
 */
export async function runSubmitCore(userId: bigint, body: any): Promise<Response> {
  const {
    campaign_id, headlines, descriptions, keywords = [],
    daily_budget = 2, max_cpc_limit = 0.3,
    bidding_strategy = "MAXIMIZE_CLICKS",
    network_search = true, network_partners = false, network_display = false,
    sitelinks = [], image_urls = [], callouts = [],
    customer_id: bodyCustomerId, mcc_account_id: bodyMccAccountId,
    ad_language, eu_political_ad,
    promotion, price, call: callExtension, structured_snippet,
    negative_keywords = [],
  } = body;
  // 从 body 中读取最终到达网址后缀（前端若未传则从 campaign DB 记录取）
  const bodyFinalUrlSuffix: string | undefined = body.final_url_suffix ?? undefined;
  // C-088: 用户在广告预览页"广告系列名(可修改)"输入框填的值（可选）
  const bodyCampaignNameCustom: string | undefined = body.campaign_name_custom ?? undefined;
  // CRAWL-04 / 07-B：用户在「落地页无法访问」硬卡弹窗里点「我已确认可访问，仍要提交」后，
  // 前端带上 confirm_reachable=true，跳过 D-050 连接级硬卡（我们机房/代理到不了 ≠ Google 到不了）。
  const confirmReachable: boolean = body.confirm_reachable === true;

  if (!campaign_id) return apiError("缺少 campaign_id");
  if (!headlines?.length || headlines.length < 3) return apiError("至少需要 3 条标题");
  if (!descriptions?.length || descriptions.length < 2) return apiError("至少需要 2 条描述");

  const campaign = await prisma.campaigns.findFirst({
    where: { id: BigInt(campaign_id), user_id: userId, is_deleted: 0 },
  });
  if (!campaign) return apiError("广告系列不存在", 404);
  if (campaign.google_campaign_id) return apiError("该广告系列已提交到 Google Ads");

  let mccAccount;
  if (bodyMccAccountId) {
    mccAccount = await prisma.google_mcc_accounts.findFirst({
      where: { id: BigInt(bodyMccAccountId), user_id: userId, is_deleted: 0 },
    });
  }
  if (!mccAccount && campaign.mcc_id) {
    mccAccount = await prisma.google_mcc_accounts.findFirst({
      where: { id: campaign.mcc_id, is_deleted: 0 },
    });
  }
  if (!mccAccount) {
    mccAccount = await prisma.google_mcc_accounts.findFirst({
      where: { user_id: userId, is_deleted: 0, is_active: 1 },
      orderBy: { id: "asc" },
    });
  }
  if (!mccAccount) return apiError("未找到 MCC 账户，请先在设置中配置");

  const adGroup = await prisma.ad_groups.findFirst({
    where: { campaign_id: campaign.id, is_deleted: 0 },
  });
  if (!adGroup) return apiError("广告组不存在");

  // ═════════════════════════════════════════════════════════════════
  // 关键字空提交硬闸 + DB 兜底（根治「广告系列中没有关键字」偶发无效广告）
  //   关键字在整条链路里只活在前端内存 kwList，靠 SemRush 的 SSE 事件异步回填。
  //   一旦提交那刻内存里为空（SemRush 慢/失败、SSE 漏收、旧草稿重开），旧逻辑会照样
  //   建出「预算+系列+广告组+RSA」却零关键字 → Google 判定无效、无法投放。
  //   这里：① 请求体为空 → 回查 keywords 表兜底；② 兜底后仍为空 → 直接拒绝提交，
  //   绝不创建无关键字的系列。
  // ═════════════════════════════════════════════════════════════════
  type SubmitKeyword = string | { text: string; matchType?: string };
  let effectiveKeywords: SubmitKeyword[] = (Array.isArray(keywords) ? keywords : []).filter(
    (k: SubmitKeyword) => (typeof k === "string" ? k.trim().length > 0 : !!k?.text && k.text.trim().length > 0),
  );
  if (effectiveKeywords.length === 0) {
    const dbKeywords = await prisma.keywords.findMany({
      where: { ad_group_id: adGroup.id },
      select: { keyword_text: true, match_type: true },
    });
    effectiveKeywords = dbKeywords
      .filter((k) => !!k.keyword_text && k.keyword_text.trim().length > 0)
      .map((k) => ({ text: k.keyword_text.trim(), matchType: (k.match_type || "PHRASE").toUpperCase() }));
    if (effectiveKeywords.length > 0) {
      console.warn(`[AdSubmit] 请求体关键字为空，已从 DB 兜底补齐 ${effectiveKeywords.length} 个 (campaign_id=${campaign.id})`);
    }
  }
  if (effectiveKeywords.length === 0) {
    return apiError(
      "该广告系列没有任何关键字，提交会导致广告无法投放（Google 会判定「广告系列中没有关键字」）。请先添加至少一个关键字后再提交。",
      422,
    );
  }

  const adSettings = await prisma.ad_default_settings.findFirst({
    where: { user_id: userId, is_deleted: 0 },
    select: { ai_rule_profile: true },
  });

  const adCreative = await prisma.ad_creatives.findFirst({
    where: { ad_group_id: adGroup.id, is_deleted: 0 },
  });
  if (!adCreative) return apiError("广告素材不存在");

  // 员工 MCC 的 token/JSON 已降级为兜底：组 Token 池有配对凭证即可提交，无需员工配置
  {
    const { poolHasCredentialFor } = await import("@/lib/google-ads/token-pool");
    if (!mccAccount.service_account_json && !(await poolHasCredentialFor(mccAccount.mcc_id))) {
      return apiError("MCC 未配置服务账号凭证，且组 Token 池中无配对的 Service Account JSON（请组长在「团队设置 → Token 池」配置）");
    }
  }

  let finalUrl = adCreative.final_url?.trim() || "";
  if (!finalUrl || !finalUrl.startsWith("http")) {
    return apiError("广告落地页 URL 无效，请确保商家链接已填写");
  }
  if (finalUrl.startsWith("http://")) {
    finalUrl = finalUrl.replace("http://", "https://");
  }

  // ═════════════════════════════════════════════════════════════════
  // D-050 第2块：提交前落地页可达性硬卡（07 稳不被拒优先，宁慢不拒）
  //   "目标网址无效(destination_not_working)" 是 Google 最常见的硬拒登之一。
  //   提交前先探测 finalUrl（3 次重试 + 跟随重定向）；仅在「确定性死链」时阻断提交，
  //   对 401/403/429（多为反爬/限流，Google 爬虫仍可达）放行，避免误杀正常落地页。
  // ═════════════════════════════════════════════════════════════════
  try {
    // 速度病灶修复：maxRetries 3→2（第 3 次重试对确定性失败几乎无增益，却最坏多烧 ~100s）；
    // maxRedirects 显式 10（联盟追踪链 6-15 跳常态，默认 5 跳会把正常长链误判 too_many_redirects）。
    const reach = await checkReachability(finalUrl, { maxRetries: 2, timeoutMs: 8000, maxRedirects: 10, country: campaign.target_country || "US" });
    let landingHardBlocked = isHardUnreachable(reach);
    const fr = reach.failureReason || "";
    const isConnLevel = fr.startsWith("network_error") || fr === "timeout" || fr === "server_error";
    const isDead404 = fr === "client_error" && (reach.statusCode === 404 || reach.statusCode === 410);
    const isBadRedirect = fr === "too_many_redirects" || fr === "redirect_no_location" || fr === "redirect_bad_location";
    // 404 双标修复：直连 HEAD/GET 404 可能是 CDN/WAF 对机房 IP、爬虫指纹的定向拦截（真实浏览器 200，
    //   rad.eu 实证）。硬卡前先用与预览页「验证」按钮同源的 tryValidateUrl 复核一次（浏览器级
    //   header + GET 内容检测 + 目标国代理重试），复核可达即放行——否则会出现「预览页验证全绿、
    //   提交却被 404 硬卡」的两套标准，员工无所适从。
    //   重定向类失败（too_many_redirects 等）同样先复核：tryValidateUrl 走 redirect:"follow"
    //   （上限 ~20 跳），能吃下 checkReachability 手动跟跳吃不下的联盟长链。
    if (landingHardBlocked && (isDead404 || isBadRedirect)) {
      const second = await tryValidateUrl(finalUrl).catch(() => null);
      if (second?.ok) {
        console.warn(`[AdSubmit] D-050 直连探测失败(${fr})但浏览器级复核可达（status=${second.status}${second.reason ? `, ${second.reason}` : ""}），放行 ${finalUrl}`);
        landingHardBlocked = false;
      }
    }
    if (landingHardBlocked) {
      // CRAWL-04 / 07-B：连接级失败（timeout/network_error/server_error）多为「本服务器出口 IP 被
      //   目标站 CDN(Akamai 等)/地域封锁」——我们到不了 ≠ 站点死了，Google 全球爬虫独立可达。
      //   404/410 在代理复核 + tryValidateUrl 双复核仍失败后，同样开放「二次确认覆盖」：反爬手段
      //   五花八门，机器判死 ≠ 真死，用户亲眼确认页面能打开就应放行（仍记日志留痕，责任随确认转移）。
      //   重定向类失败同理可覆盖——5-10 跳上限是我们的探测器限制，不是页面死了的证据。
      const overridable = isConnLevel || isDead404 || isBadRedirect;
      if (confirmReachable && overridable) {
        console.warn(`[AdSubmit] D-050 落地页硬卡：用户已确认可访问，覆盖放行 ${finalUrl} reason=${fr} status=${reach.statusCode}`);
      } else {
        console.warn(`[AdSubmit] D-050 落地页硬卡阻断: ${finalUrl} reason=${fr} status=${reach.statusCode} overridable=${overridable}`);
        const msg = `落地页无法访问（${fr}${reach.statusCode ? `, HTTP ${reach.statusCode}` : ""}），为避免被 Google 以「目标网址无效」拒登，已阻止本次提交。请确认 ${reach.finalUrl || finalUrl} 能正常打开后再提交。`;
        // overridable=true 时附带 data 标志，前端据此弹出「我已确认可访问，仍要提交」二次确认按钮。
        return Response.json(
          {
            code: -1,
            message: msg,
            data: overridable
              ? { reason: "landing_unreachable_overridable", finalUrl: reach.finalUrl || finalUrl, failureReason: fr }
              : null,
          },
          { status: 422 },
        );
      }
    }
    if (!reach.reachable) {
      console.warn(`[AdSubmit] D-050 落地页可达性存疑（放行，疑似反爬/限流）: ${finalUrl} reason=${reach.failureReason} status=${reach.statusCode}`);
    } else {
      // 软 404 补检（审计病灶 #6）：HTTP 200 的「Page Not Found / 链接已失效」页对 checkReachability
      // 是 reachable，却是联盟落地页最常见的失效形态，Google 照样以 misleading/无效目标拒登。
      // 用 quickCheckUrl（单 UA 一次 GET + 软404/无效链接文案检测，≤15s）补一道；命中后同样走
      // confirm_reachable 覆盖通道——文案检测有误报可能（标题含 "404" 的商品页等），不做不可覆盖硬卡。
      try {
        const { quickCheckUrl } = await import("@/lib/url-validator");
        const soft = await quickCheckUrl(finalUrl);
        const isSoftDead = !soft.ok && soft.status > 0 && soft.status < 400;
        if (isSoftDead && !confirmReachable) {
          console.warn(`[AdSubmit] D-050 软404阻断: ${finalUrl} status=${soft.status} reason=${soft.reason}`);
          return Response.json(
            {
              code: -1,
              message: `落地页返回了正常状态码（HTTP ${soft.status}）但内容疑似失效页（${soft.reason || "含 404/失效链接文案"}）。Google 审核会以「目标无效/误导」拒登。请人工打开 ${soft.finalUrl || finalUrl} 确认内容正常后再提交。`,
              data: { reason: "landing_unreachable_overridable", finalUrl: soft.finalUrl || finalUrl, failureReason: "soft_404" },
            },
            { status: 422 },
          );
        }
        if (isSoftDead && confirmReachable) {
          console.warn(`[AdSubmit] D-050 软404：用户已确认可访问，覆盖放行 ${finalUrl} reason=${soft.reason}`);
        }
      } catch (e) {
        console.warn(`[AdSubmit] D-050 软404补检异常（放行）: ${e instanceof Error ? e.message : e}`);
      }
    }
  } catch (e) {
    // 探测本身异常（不应发生，checkReachability 内部已捕获）→ 不阻断，记录日志
    console.warn(`[AdSubmit] D-050 落地页可达性探测异常（放行）: ${e instanceof Error ? e.message : e}`);
  }

  // ═════════════════════════════════════════════════════════════════
  // AdsBot Destination Preflight（自 kyads 移植）：D-050 之后的第二道落地页硬卡。
  //   D-050 验证的是「页面活着」；这里验证的是「Google 的审核爬虫（AdsBot-Google UA）
  //   能访问」。部分站点/CDN 针对 bot UA 拦截——浏览器可达但 AdsBot 被 403/503，
  //   Google 会以 DESTINATION_NOT_WORKING 拒登。
  //   仅对 not_publishable_status（浏览器可达 + AdsBot 不可达 = bot 被针对性拦截）阻断；
  //   server_blocked（两边都不可达，多为本机出口问题）交由上面 D-050 的结论，这里放行。
  //   覆盖机制沿用 confirm_reachable：用户二次确认后放行（留痕）。
  // ═════════════════════════════════════════════════════════════════
  try {
    const { checkAdsBotDestinationReachable } = await import("@/lib/google-ads/destination-preflight");
    const preflightSuffix =
      (bodyFinalUrlSuffix ?? ((campaign as any).final_url_suffix as string | null) ?? "") || "";
    const preflight = await checkAdsBotDestinationReachable({ finalUrl, finalUrlSuffix: preflightSuffix });
    if (!preflight.ok && preflight.reason === "not_publishable_status") {
      if (confirmReachable) {
        console.warn(`[AdSubmit] AdsBot 预检：用户已确认可访问，覆盖放行 ${preflight.checkedUrl} adsbot=${preflight.status ?? preflight.errorMessage}`);
      } else {
        console.warn(`[AdSubmit] AdsBot 预检阻断: ${preflight.checkedUrl} adsbot=${preflight.status ?? preflight.errorMessage} browser=${preflight.browserStatus}`);
        const statusText = preflight.status ? `HTTP ${preflight.status}` : (preflight.errorMessage || "无响应");
        return Response.json(
          {
            code: -1,
            message: `落地页拦截了 Google 审核爬虫（AdsBot-Google 访问返回 ${statusText}，但普通浏览器可正常访问）。Google 审核时会以「目标网址无效(DESTINATION_NOT_WORKING)」拒登。请联系商家/CDN 放行 AdsBot-Google，或更换落地页。检测 URL: ${preflight.checkedUrl}`,
            data: {
              reason: "landing_unreachable_overridable",
              finalUrl: preflight.finalUrl,
              failureReason: "adsbot_blocked",
            },
          },
          { status: 422 },
        );
      }
    } else if (!preflight.ok) {
      console.warn(`[AdSubmit] AdsBot 预检不可下结论（${preflight.reason}，放行）: ${preflight.checkedUrl}`);
    }
  } catch (e) {
    console.warn(`[AdSubmit] AdsBot 预检异常（放行）: ${e instanceof Error ? e.message : e}`);
  }

  // ═════════════════════════════════════════════════════════════════
  // C-033: Sitelinks 禁止词预筛 → AI 自动返工（最多3轮），仍违规则移除该条
  //   - keywords/headlines/descriptions/callouts 不在此处处理，保持原有硬阻断
  //   - Sitelinks 由 AI 生成，员工难以手动修改，故改为 AI 自动返工
  //   - QA-1=B: 最多3轮 / QA-2=B: 3轮仍违规整条移除 / QA-3=A: 写回DB
  // ═════════════════════════════════════════════════════════════════
  try {
    const _profile = normalizeAiRuleProfile(adSettings?.ai_rule_profile);
    const _persona = getActivePersona(_profile);
    const _allForbidden = [...new Set([..._persona.forbidden_terms, ..._profile.forbidden_terms])];

    if (_allForbidden.length > 0 && Array.isArray(sitelinks) && sitelinks.length > 0) {
      type SitelinkItem = { title?: string | null; desc1?: string | null; desc2?: string | null; description1?: string | null; description2?: string | null; url?: string | null; finalUrl?: string | null };
      const slArr = sitelinks as SitelinkItem[];

      // 检查单条 sitelink 是否有禁止词，返回命中词列表
      const getSlViolations = (sl: SitelinkItem): string[] => {
        const fields = [sl.title, sl.desc1, sl.desc2, sl.description1, sl.description2].map((v) => String(v || "").trim()).filter(Boolean);
        const hits: string[] = [];
        for (const f of fields) {
          const matched = includesForbiddenTerm(f, _allForbidden);
          if (matched && !hits.includes(matched)) hits.push(matched);
        }
        return hits;
      };

      // 找出需要返工的条目下标
      const violatingIdxs = slArr.map((sl, i) => ({ i, hits: getSlViolations(sl) })).filter((x) => x.hits.length > 0);

      if (violatingIdxs.length > 0) {
        console.warn(`[C-033] Sitelinks 禁止词命中 ${violatingIdxs.length} 条，启动 AI 返工`);

        // AI 返工：每条违规 sitelink 独立调用，最多 3 轮
        const toRemove = new Set<number>();
        for (const { i, hits } of violatingIdxs) {
          const sl = slArr[i];
          const titleOrig = String(sl.title || "").trim();
          const desc1Orig = String(sl.desc1 || sl.description1 || "").trim();
          const desc2Orig = String(sl.desc2 || sl.description2 || "").trim();
          let rewritten: { title: string; desc1: string; desc2: string } | null = null;

          for (let round = 1; round <= 3; round++) {
            try {
              const raw = await callAiWithFallback("sitelink_rewrite", [
                {
                  role: "user",
                  content: [
                    `You are a Google Ads copywriter. Rewrite the sitelink to avoid ALL forbidden words.`,
                    `Forbidden words (do NOT use these words or close variants/synonyms): ${JSON.stringify(hits)}`,
                    `Original title (max 25 chars): "${titleOrig}"`,
                    `Original desc1 (max 35 chars): "${desc1Orig}"`,
                    `Original desc2 (max 35 chars): "${desc2Orig}"`,
                    `Rules:`,
                    `1. Keep the same page intent and meaning.`,
                    `2. Stay within char limits: title≤25, desc1≤35, desc2≤35.`,
                    `3. Return ONLY valid JSON, no extra text: {"title":"...","desc1":"...","desc2":"..."}`,
                  ].join("\n"),
                },
              ], 120);

              const parsed = JSON.parse(extractJsonFromAi(raw)) as { title?: string; desc1?: string; desc2?: string };
              const t = fitAdTextSync(String(parsed.title || ""), 25);
              const d1 = fitAdTextSync(String(parsed.desc1 || ""), 35);
              const d2 = fitAdTextSync(String(parsed.desc2 || ""), 35);

              // 校验：重写后是否仍有禁止词
              const stillViolates = [t, d1, d2].some((f) => f && includesForbiddenTerm(f, _allForbidden));
              if (!stillViolates && t.length >= 2) {
                rewritten = { title: t, desc1: d1, desc2: d2 };
                console.warn(`[C-033] Sitelink[${i}] 第 ${round} 轮返工成功: "${titleOrig}" → "${t}"`);
                break;
              }
              console.warn(`[C-033] Sitelink[${i}] 第 ${round} 轮返工仍违规，继续重试`);
            } catch (e) {
              console.warn(`[C-033] Sitelink[${i}] 第 ${round} 轮 AI 调用失败:`, e instanceof Error ? e.message : e);
            }
          }

          if (rewritten) {
            // 替换回原数组（兼容两种字段名格式）
            slArr[i] = { ...sl, title: rewritten.title, desc1: rewritten.desc1, desc2: rewritten.desc2, description1: rewritten.desc1, description2: rewritten.desc2 };
          } else {
            // 3 轮仍违规 → 标记移除（QA-2=B）
            console.warn(`[C-033] Sitelink[${i}] 3 轮返工失败，移除该条: "${titleOrig}"`);
            toRemove.add(i);
          }
        }

        // 移除失败条目，写回 sitelinks 数组
        const cleaned = slArr.filter((_, i) => !toRemove.has(i));
        sitelinks.splice(0, sitelinks.length, ...cleaned);

        // QA-3: 写回 DB
        await prisma.ad_creatives.update({
          where: { id: adCreative.id },
          data: { sitelinks: cleaned as any },
        }).catch((e) => console.warn("[C-033] sitelinks 写回 DB 失败:", e instanceof Error ? e.message : e));

        console.warn(`[C-033] Sitelinks 返工完成：原 ${slArr.length + toRemove.size} 条 → 保留 ${cleaned.length} 条`);
      }
    }
  } catch (e) {
    // C-033 返工异常不阻断提交，仅记录日志
    console.warn("[C-033] Sitelinks 禁止词返工异常（不阻断提交）:", e instanceof Error ? e.message : e);
  }

  // ═════════════════════════════════════════════════════════════════
  // D-082: headlines/descriptions/callouts 命中禁止词 → AI 自动重写（最多 3 轮）
  //   - 与 C-033（sitelinks）同口径，但失败处理不同：3 轮仍违规 → 不删、保留原文，
  //     交给下方 collectAiRuleViolations 硬挡报错，通知员工手动改（07 拍板）。
  //   - keywords 来自 SemRush 词池不做改写，仍由下方硬挡处理。
  // ═════════════════════════════════════════════════════════════════
  try {
    const _allForbidden = [
      ...new Set([
        ...getActivePersona(normalizeAiRuleProfile(adSettings?.ai_rule_profile)).forbidden_terms,
        ...normalizeAiRuleProfile(adSettings?.ai_rule_profile).forbidden_terms,
      ]),
    ];
    if (_allForbidden.length > 0) {
      const _callAi = (prompt: string) =>
        callAiWithFallback("forbidden_rewrite", [{ role: "user", content: prompt }], 120);
      if (Array.isArray(headlines) && headlines.length > 0) {
        const r = await autoRewriteForbiddenTerms(headlines as string[], _allForbidden, { fieldLabel: "ad headline", maxChars: 30, caseStyle: "title", callAi: _callAi });
        headlines.splice(0, headlines.length, ...r.items);
        if (r.rewroteCount > 0 || r.stillViolating.length > 0) console.warn(`[D-082] 提交阶段标题禁止词改写：rewrote=${r.rewroteCount} stillViolating=${r.stillViolating.length}`);
      }
      if (Array.isArray(descriptions) && descriptions.length > 0) {
        const r = await autoRewriteForbiddenTerms(descriptions as string[], _allForbidden, { fieldLabel: "ad description", maxChars: 90, caseStyle: "sentence", callAi: _callAi });
        descriptions.splice(0, descriptions.length, ...r.items);
        if (r.rewroteCount > 0 || r.stillViolating.length > 0) console.warn(`[D-082] 提交阶段描述禁止词改写：rewrote=${r.rewroteCount} stillViolating=${r.stillViolating.length}`);
      }
      if (Array.isArray(callouts) && callouts.length > 0) {
        const r = await autoRewriteForbiddenTerms(callouts as string[], _allForbidden, { fieldLabel: "callout", maxChars: 25, caseStyle: "title", callAi: _callAi });
        callouts.splice(0, callouts.length, ...r.items);
        if (r.rewroteCount > 0 || r.stillViolating.length > 0) console.warn(`[D-082] 提交阶段标注禁止词改写：rewrote=${r.rewroteCount} stillViolating=${r.stillViolating.length}`);
      }
    }
  } catch (e) {
    console.warn("[D-082] 提交阶段禁止词自动改写异常（不阻断，转下方硬挡）：", e instanceof Error ? e.message : e);
  }

  // BUG-15：提前取商家名传入硬规则校验，品牌词（Miraclesuit ⊃ miracle）豁免误杀
  const merchantRec = await prisma.user_merchants.findFirst({
    where: { id: campaign.user_merchant_id, is_deleted: 0 },
    select: { merchant_name: true },
  });

  // ═════════════════════════════════════════════════════════════════
  // D-162：政策风险表达（risk-free / 医疗宣称等）硬挡前先 AI 自动重写
  //   - 与 D-082 禁止词同理：机器能改的先改，改不掉的才落到下方硬挡；
  //   - 只在启用 enforce_policy_check 时执行（与 collectAiRuleViolations 同一开关）；
  //   - keywords（SemRush 词池）与 sitelinks 不改写，仍走硬挡。
  // ═════════════════════════════════════════════════════════════════
  try {
    const _profile = normalizeAiRuleProfile(adSettings?.ai_rule_profile);
    const _persona = getActivePersona(_profile);
    if (_persona.enforce_policy_check || _profile.enforce_policy_check) {
      const { autoRewritePolicyRisk } = await import("@/lib/ai-rule-profile");
      const _merchantName = merchantRec?.merchant_name || "";
      const _callAi = (prompt: string) =>
        callAiWithFallback("forbidden_rewrite", [{ role: "user", content: prompt }], 160);
      const targets: Array<{ arr: unknown; label: string; maxChars: number; caseStyle: "title" | "sentence" }> = [
        { arr: headlines, label: "ad headline", maxChars: 30, caseStyle: "title" },
        { arr: descriptions, label: "ad description", maxChars: 90, caseStyle: "sentence" },
        { arr: callouts, label: "callout", maxChars: 25, caseStyle: "title" },
      ];
      // 速度病灶修复：三个字段的改写互不依赖，由顺序 await 改为并行（原最坏 3×AI 重写串行）
      await Promise.all(targets.map(async (t) => {
        if (!Array.isArray(t.arr) || t.arr.length === 0) return;
        const r = await autoRewritePolicyRisk(t.arr as string[], {
          fieldLabel: t.label, maxChars: t.maxChars, caseStyle: t.caseStyle,
          merchantName: _merchantName, callAi: _callAi,
        });
        (t.arr as string[]).splice(0, (t.arr as string[]).length, ...r.items);
        if (r.rewroteCount > 0 || r.stillViolating.length > 0) {
          console.warn(`[D-162] 提交阶段政策风险表达改写（${t.label}）：rewrote=${r.rewroteCount} stillViolating=${r.stillViolating.length}`);
        }
      }));
    }
  } catch (e) {
    console.warn("[D-162] 政策风险表达自动改写异常（不阻断，转下方硬挡）：", e instanceof Error ? e.message : e);
  }

  const aiRuleViolations = collectAiRuleViolations({
    profile: adSettings?.ai_rule_profile,
    merchantName: merchantRec?.merchant_name || "",
    keywords,
    headlines,
    descriptions,
    callouts,
    sitelinks,
  });
  if (aiRuleViolations.length > 0) {
    return apiError(`AI 设定硬规则未通过：${aiRuleViolations.join("；")}`);
  }

  // ═════════════════════════════════════════════════════════════════
  // C-016: Google 官方政策 + 事实证据 软闸（自动重写，不阻断提交）
  //   - collectGooglePolicyViolations：绝对化/承诺/符号/国家标签泄漏
  //   - validateClaims：百分比/货币/电话/年限/免运/保修 对证据
  //   - 有违规 → rewriteViolationsOnly 3 轮 AI 单条重写 + safe-template 兜底
  //   - 仍有失败条目 → 允许继续提交（safe-template 已保证 Google 政策合规）
  // ═════════════════════════════════════════════════════════════════
  try {
    const { collectGooglePolicyViolations } = await import("@/lib/ai-rule-profile");
    const { validateClaims } = await import("@/lib/claim-validator");
    const { rewriteViolationsOnly } = await import("@/lib/ai-retry-loop");
    const { extractBrandRoot } = await import("@/lib/country-url-resolver");

    // BUG-15：商家名已在上方硬规则校验前查询，此处直接复用
    const brandRoot = extractBrandRoot(merchantRec?.merchant_name || "");
    const market = getAdMarketConfig(campaign.target_country || "US");
    const country = campaign.target_country || "US";
    const languageCode = (ad_language as string | undefined) || market.languageCode || "en";
    const languageName = market.languageCode ? market.languageCode : "English";

    const evidence = {
      rawMentions: (adCreative.crawl_cache as any)?.rawMentions,
      promoRegex: (adCreative.crawl_cache as any)?.promoRegex,
      phone: ((adCreative.crawl_cache as any)?.phoneCandidates || [])[0] || null,
      features: (adCreative.crawl_cache as any)?.features || [],
    };

    const runGate = async (items: string[], field: "headline" | "description", maxLen: number, minLen: number): Promise<string[]> => {
      const gv = collectGooglePolicyViolations(
        field === "headline"
          ? { headlines: items, brandRoot }
          : { descriptions: items, brandRoot }
      ).filter((v) => v.field === field);
      const cv = validateClaims({
        texts: items.map((t, i) => ({ field, index: i, text: t })),
        evidence,
        country,
      });
      const map = new Map<number, string[]>();
      for (const v of gv) {
        if (!map.has(v.index)) map.set(v.index, []);
        map.get(v.index)!.push(v.hint);
      }
      for (const u of cv.unsupported) {
        if (!map.has(u.index)) map.set(u.index, []);
        map.get(u.index)!.push(u.hint);
      }
      if (map.size === 0) return items;
      const hints = [...map.entries()].map(([index, h]) => ({ index, hint: h.join(" | ") }));
      console.warn(`[AdSubmit] C-016 ${field} 违规 ${hints.length} 条，触发自动重写`);
      const result = await rewriteViolationsOnly({
        items,
        violations: hints,
        opts: {
          field,
          brandRoot,
          country,
          languageCode,
          languageName,
          maxLen,
          minLen,
          maxRounds: 3,
        },
        validateAfterFn: (text) => {
          const gv2 = collectGooglePolicyViolations(
            field === "headline" ? { headlines: [text], brandRoot } : { descriptions: [text], brandRoot }
          );
          if (gv2.length > 0) return false;
          const cv2 = validateClaims({ texts: [{ field, index: 0, text }], evidence, country });
          return cv2.ok;
        },
      });
      console.warn(`[AdSubmit] ${field} 重写：成功 ${result.rewritten.length}，兜底 ${result.degraded.length}`);
      return result.items;
    };

    // 速度病灶修复：headline / description 两个闸门互不依赖（各自校验+重写各自的数组），
    // 原顺序 await 让总耗时 = 两者之和（各自最多 3 轮 AI 重写）。并行后取较慢者。
    const [newHeadlines, newDescriptions] = await Promise.all([
      runGate(headlines as string[], "headline", 30, 2),
      runGate(descriptions as string[], "description", 90, 40),
    ]);
    // 写回本次 body 使用的变量（submit 后续逻辑会读 headlines/descriptions 本地变量）
    headlines.splice(0, headlines.length, ...newHeadlines);
    descriptions.splice(0, descriptions.length, ...newDescriptions);

    // 持久化改写结果
    await prisma.ad_creatives.update({
      where: { id: adCreative.id },
      data: {
        headlines: newHeadlines as any,
        descriptions: newDescriptions as any,
      },
    }).catch((e) => console.warn("[AdSubmit] 政策重写写回 DB 失败:", e instanceof Error ? e.message : e));
  } catch (gateErr) {
    console.warn("[AdSubmit] C-016 软闸异常（不阻断提交）:", gateErr instanceof Error ? gateErr.message : gateErr);
  }

  if (sitelinks.length > 0) {
    const badLinks: string[] = [];
    for (const sl of sitelinks as { finalUrl?: string; title?: string }[]) {
      const slUrl = (sl.finalUrl || "").trim();
      if (!slUrl || !slUrl.startsWith("http")) {
        badLinks.push(sl.title || slUrl || "(空)");
      }
    }
    if (badLinks.length > 0) {
      return apiError(`站内链接 URL 格式无效，请修正后再提交：${badLinks.join("、")}`);
    }

    // 严查：站内链接与落地页语言版本一致性。落地页 /en 却配 /fr、/nl（其他语言版首页或子页，
    // rad.eu 实证）会把用户带进另一语言站点、Google 亦可能判 misleading——提交前统一剔除并留痕，
    // 兜住生成阶段修复前已落库的旧草稿/员工手填的错配链接。
    // 审计病灶 #3 补齐：提交层此前只查 locale，不查发现阶段的垃圾页黑名单
    // （isBadSitelinkUrl：登录/购物车/政策页等；isLowValueSitelink：低价值标题/URL），
    // 旧草稿里修复前漏进的垃圾链接会绕过发现阶段直达 Google——这里补成同一套标准。
    {
      const slArr = sitelinks as { finalUrl?: string; title?: string }[];
      const kept = slArr.filter((sl) => {
        const slUrl = (sl.finalUrl || "").trim();
        if (!isSitelinkLocaleCompatible(slUrl, finalUrl)) return false;
        if (isBadSitelinkUrl(slUrl)) return false;
        if (isLowValueSitelink(slUrl, sl.title || "")) return false;
        return true;
      });
      if (kept.length !== slArr.length) {
        const removed = slArr.filter((sl) => !kept.includes(sl));
        console.warn(
          `[AdSubmit] 剔除不合格站内链接 ${removed.length} 条（locale/黑名单/低价值，落地页=${finalUrl}）: ${removed.map((r) => `${r.title || "(无标题)"}(${r.finalUrl})`).join("、")}`,
        );
        sitelinks.splice(0, sitelinks.length, ...kept);
      }
    }

    // D-050 第2块：sitelink 提交前可达性硬卡——确定性死链的 sitelink 直接剔除（不阻断整条广告）。
    //   单条 sitelink 死链同样会被 Google 标记，影响整体审核；剔除比阻断更稳妥。
    try {
      const slArr = sitelinks as { finalUrl?: string; title?: string }[];
      const checks = await Promise.all(
        slArr.map(async (sl) => {
          const slUrl = (sl.finalUrl || "").trim();
          try {
            // country：直连 404 时走目标国代理复核（与落地页同口径），避免地域封锁误剔正常 sitelink
            const r = await checkReachability(slUrl, { maxRetries: 1, timeoutMs: 6000, country: campaign.target_country || "US" });
            return isHardUnreachable(r) ? { dead: true, title: sl.title || slUrl, reason: r.failureReason } : { dead: false };
          } catch {
            return { dead: false };
          }
        }),
      );
      const kept = slArr.filter((_, i) => !checks[i].dead);
      const removed = checks.filter((c) => c.dead) as { dead: true; title: string; reason?: string }[];
      if (removed.length > 0) {
        console.warn(`[AdSubmit] D-050 剔除死链 sitelink ${removed.length} 条: ${removed.map((r) => `${r.title}(${r.reason})`).join("、")}`);
        sitelinks.splice(0, sitelinks.length, ...kept);
      }
    } catch (e) {
      console.warn(`[AdSubmit] D-050 sitelink 可达性探测异常（不阻断）: ${e instanceof Error ? e.message : e}`);
    }
  }

  const credentials = {
    mcc_id: mccAccount.mcc_id,
    developer_token: mccAccount.developer_token || "",
    service_account_json: mccAccount.service_account_json || "",
  };

  let customerId = bodyCustomerId || campaign.customer_id;
  if (!customerId) {
    const { listMccChildAccounts, checkCidAvailability } = await import("@/lib/google-ads/cid");
    const cids = await listMccChildAccounts(credentials);
    if (cids.length === 0) {
      return apiError("MCC 下没有可用的客户账号（CID），请检查 MCC 是否已关联子账户");
    }
    for (const cid of cids) {
      const available = await checkCidAvailability(credentials, cid.customer_id);
      if (available) {
        customerId = cid.customer_id;
        break;
      }
    }
    if (!customerId) return apiError(`MCC 下 ${cids.length} 个 CID 均不可用（已有广告或账户未启用），请新增 CID 或检查账户状态`);
  } else {
    try {
      const testQuery = `SELECT customer.id, customer.status FROM customer LIMIT 1`;
      const rows = await queryGoogleAds(credentials, customerId, testQuery);
      const status = rows[0]?.customer && typeof rows[0].customer === "object"
        ? (rows[0].customer as Record<string, unknown>).status
        : undefined;
      if (status === "SUSPENDED" || status === "CLOSED" || status === "CANCELLED") {
        return apiError(`CID ${customerId} 账户状态异常（${status}），请重新同步 CID 列表并选择其他可用账户`);
      }
    } catch (preCheckErr) {
      const preMsg = preCheckErr instanceof Error ? preCheckErr.message : String(preCheckErr);
      if (preMsg.includes("CUSTOMER_NOT_ENABLED") || preMsg.includes("not yet enabled") || preMsg.includes("has been deactivated") || preMsg.includes("账户未启用") || preMsg.includes("已停用")) {
        return apiError(`CID ${customerId} 账户未启用或已停用，无法提交广告。请点击「同步 CID」刷新列表，选择其他可用 CID 后重试。`);
      }
      if (preMsg.includes("PERMISSION_DENIED")) {
        return apiError(`CID ${customerId} 无访问权限，请确认该 CID 属于当前 MCC 且状态正常`);
      }
      console.warn("[AdSubmit] CID 预检查异常（将继续尝试提交）:", preMsg);
    }
  }

  let cid = customerId.replace(/-/g, "");

  const submitMerchant = await prisma.user_merchants.findFirst({
    where: { id: campaign.user_merchant_id, is_deleted: 0 },
    select: {
      merchant_name: true, merchant_id: true, platform: true, platform_connection_id: true,
      tracking_link: true, campaign_link: true, connection_campaign_links: true,
      tracking_status: true, parent_network: true, parent_blacklisted: true, parent_checked_at: true,
    },
  });
  if (!submitMerchant) return apiError("商家不存在", 404);

  // ═════════════════════════════════════════════════════════════════
  // D-101 追踪链接 + 上级联盟自动巡航硬闸（创建广告时）
  //   按投放国代理跟随联盟追踪链接的整条跳转链，识别上级联盟；命中该平台黑名单 → 硬拦截。
  //   结果缓存在 user_merchants（7 天 TTL）：复用避免每次提交都巡航。
  //   仅「黑名单」硬阻断；no_tracking / resolve_failed 仅记录（主 CRM 追踪走 final_url_suffix，
  //   且可达性另有 D-050 闸门），不阻断提交。
  // ═════════════════════════════════════════════════════════════════
  try {
    // 取该商家本平台账号的联盟追踪链接（优先账号级 campaign_link，其次通用字段）
    let affiliateUrl = "";
    const connLinks = (submitMerchant.connection_campaign_links || null) as Record<string, string> | null;
    if (connLinks && submitMerchant.platform_connection_id) {
      affiliateUrl = String(connLinks[String(submitMerchant.platform_connection_id)] || "").trim();
    }
    if (!affiliateUrl) affiliateUrl = String(submitMerchant.campaign_link || "").trim();
    if (!affiliateUrl) affiliateUrl = String(submitMerchant.tracking_link || "").trim();

    if (affiliateUrl && /^https?:\/\//i.test(affiliateUrl)) {
      const TTL_MS = 7 * 24 * 60 * 60 * 1000;
      const checkedAt = submitMerchant.parent_checked_at ? new Date(submitMerchant.parent_checked_at).getTime() : 0;
      const cacheFresh = checkedAt > 0 && Date.now() - checkedAt < TTL_MS && submitMerchant.tracking_status !== "unchecked";

      let blocked = false;
      let blockedNetwork = submitMerchant.parent_network || "";

      if (cacheFresh) {
        // 复用缓存：仅看黑名单结论
        blocked = submitMerchant.parent_blacklisted === 1 || submitMerchant.tracking_status === "forbidden_network";
      } else {
        // 现场巡航（纯 HTTP，足以识别跳板域名/上级联盟；总超时 60s）
        const { resolveAffiliateLink } = await import("@/lib/affiliate-link-resolver");
        const cruise = await Promise.race([
          resolveAffiliateLink(affiliateUrl, campaign.target_country || "US", submitMerchant.platform || null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 60000)),
        ]);
        if (cruise) {
          blocked = cruise.status === "forbidden_network";
          blockedNetwork = cruise.parentNetwork || blockedNetwork;
          await prisma.user_merchants.update({
            where: { id: campaign.user_merchant_id! },
            data: {
              parent_network: cruise.parentNetwork,
              parent_blacklisted: cruise.status === "forbidden_network" ? 1 : 0,
              tracking_status: cruise.status,
              resolved_final_url: cruise.finalUrl?.slice(0, 1024) || null,
              resolve_chain: cruise.chain.slice(0, 20) as unknown as object,
              parent_checked_at: new Date(),
              parent_check_reason: (cruise.error || (cruise.status === "ok" ? "巡航通过" : cruise.status)).slice(0, 255),
            },
          }).catch((e) => console.warn("[AdSubmit] D-101 巡航结果写回失败:", e instanceof Error ? e.message : e));
        } else {
          console.warn("[AdSubmit] D-101 巡航超时（60s），放行本次提交（不阻断）");
        }
      }

      if (blocked) {
        console.warn(`[AdSubmit] D-101 上级联盟黑名单拦截: merchant=${submitMerchant.merchant_name} platform=${submitMerchant.platform} parent=${blockedNetwork}`);
        return apiError(
          `该商家的联盟追踪链接属于上级联盟「${blockedNetwork || "未知"}」，已被「${submitMerchant.platform}」平台列入黑名单，不能投放。请更换商家或联系组长调整黑名单后重试。`,
          422,
        );
      }
    }
  } catch (cruiseErr) {
    // 巡航本身异常不阻断提交（黑名单拦截已在上方 return；此处仅兜底）
    console.warn("[AdSubmit] D-101 巡航异常（不阻断提交）:", cruiseErr instanceof Error ? cruiseErr.message : cruiseErr);
  }

  const submitAdSettings = await prisma.ad_default_settings.findFirst({
    where: { user_id: userId, is_deleted: 0 },
    select: { naming_rule: true },
  });

  const platformLabel = await resolvePlatformLabel(userId, submitMerchant.platform || "", submitMerchant.platform_connection_id);

  // ═════════════════════════════════════════════════════════════════
  // D-039 H4(C 模式) — 提交前 final gate
  //   - critical 违规（不公平优势 / 不当内容 / 电话号码 / 品牌名泄漏 / 行业禁词） → 自动修复后放行
  //   - minor 违规（过度大写） → 仅记录警告，不阻断
  //   - 异常时不阻断（避免误伤正常提交）
  //   D-161：合规上下文（商标策略/行业档/商家名归一化）与生成阶段同源，消除两端规则不一致
  // ═════════════════════════════════════════════════════════════════
  let h4AutoFix: {
    criticalCount: number;
    rules: string[];
    rewroteCount: number;
    droppedCount: number;
    backfilledCount: number;
    removed: string[];
    added: string[];
  } | null = null;
  try {
    const { checkAdCompliance } = await import("@/lib/ad-compliance-checker");
    const { lintRewriteAndBackfill } = await import("@/lib/intellicenter/ad-creation/compliance-linter");
    const { detectIndustryProfile, INDUSTRY_PROFILES } = await import("@/lib/industry-profile");
    const { extractBrandRoot } = await import("@/lib/country-url-resolver");

    // D-161 修复：crawl_cache 是 JSON 列（Prisma 返回对象，不是字符串）——旧代码
    // `typeof === "string"` 永远不成立，pageText 恒为空，行业画像退化成通用档，
    // 导致提交端与生成端行业禁词表不一致。这里对象/字符串两种形态都兼容。
    let cacheObj: { pageText?: string; complianceMeta?: { trademarkPolicy?: string; allowBrand?: boolean; industryId?: string | null; merchantNameUsed?: string } } | null = null;
    try {
      if (adCreative.crawl_cache) {
        cacheObj = typeof adCreative.crawl_cache === "string"
          ? JSON.parse(adCreative.crawl_cache)
          : (adCreative.crawl_cache as any);
      }
    } catch {}
    const meta = cacheObj?.complianceMeta;

    // 商家名归一化与生成端一致（extractBrandRoot 去国家后缀），避免推导出不同品牌 token
    const h4MerchantName = meta?.merchantNameUsed || extractBrandRoot(submitMerchant.merchant_name || "");
    // 行业档优先复用生成阶段结论；无 meta（旧草稿/手动路径）时用修好的 pageText 现场检测
    const industryProfile = meta?.industryId
      ? (INDUSTRY_PROFILES.find((p) => p.id === meta.industryId) ?? null)
      : detectIndustryProfile({
        merchantName: h4MerchantName,
        category: null,
        pageText: (cacheObj?.pageText || "").slice(0, 2000),
      });
    // 商标策略与生成端 policy-preflight 同源：画像判 authorized/own_brand 的商家品牌名合法。
    // 叠加品牌自有站推定（Wellfit 实证）：meta.allowBrand 是生成时快照（AI 画像默认
    // unauthorized 常误判 false），品牌词=落地域名且近 90 天无商标类拒登 → 按 true 处理，
    // 避免 H4 把品牌官网导流单的品牌词自动重写掉。
    let allowBrand = meta?.allowBrand === true;
    if (!allowBrand) {
      const { shouldAllowBrandByOwnDomain } = await import("@/lib/intellicenter/ad-creation/policy-preflight");
      allowBrand = await shouldAllowBrandByOwnDomain(campaign.user_merchant_id, h4MerchantName, finalUrl);
      if (allowBrand) {
        console.log(`[AdSubmit] H4 品牌自有站推定放行品牌词：merchant=${h4MerchantName} url=${finalUrl}`);
      }
    }

    const finalGate = checkAdCompliance(
      headlines as string[],
      descriptions as string[],
      { industryProfile, merchantName: h4MerchantName, allowBrand },
    );
    if (finalGate.criticalCount > 0) {
      // ═══ C-119：提交无障碍 —— 不再硬阻断让员工去改，智能自动修复后直接放行 ═══
      // 07 铁律：自动避障之后就不该再因"违规"挡住提交。检出 critical → AI 证据感知重写 +
      //   仍违规删除 + 静态模板补足数量，用修复后的文案继续提交（与创建阶段 C-118 同一套闭环）。
      const criticals = finalGate.violations.filter((v) => v.severity === "critical");
      const summary = criticals.slice(0, 5).map((v) => `${v.field}#${v.index}「${v.text.slice(0, 30)}」→ ${v.rule}`).join("；");
      // D-161 埋点：记录规则分布 + 是否带生成阶段 meta（区分「生成漏检」vs「旧草稿/员工手改」），一周后复盘
      const ruleDist = [...new Set(criticals.map((v) => v.rule.split(":")[0]))];
      console.warn(
        `[AdSubmit] H4 检出 ${finalGate.criticalCount} 条 critical，启动自动修复（不阻断提交）cam=${campaign.id} hasGenMeta=${!!meta} rules=[${ruleDist.join(",")}]：${summary}`,
      );
      const beforeSnapshot = new Set([...(headlines as string[]), ...(descriptions as string[]), ...(Array.isArray(callouts) ? callouts as string[] : [])]);
      const rewriteCallAi = async (prompt: string): Promise<string> =>
        callAiWithFallback(
          "ad_creation_intelligent",
          [
            { role: "system", content: "You are a senior Google Ads copywriter. Return ONLY valid JSON, no markdown." },
            { role: "user", content: prompt },
          ],
          1024,
        );
      const repaired = await lintRewriteAndBackfill(
        { headlines: headlines as string[], descriptions: descriptions as string[], callouts: callouts as string[] },
        {
          merchantName: h4MerchantName,
          industryProfile,
          industryLabel: industryProfile?.label ?? null,
          allowBrand,
          // 保持现有数量（创建阶段已满 15/4），删除违规后补回相同数量
          targetHeadlines: (headlines as string[]).length,
          targetDescriptions: (descriptions as string[]).length,
        },
        rewriteCallAi,
      );
      headlines.splice(0, headlines.length, ...repaired.cleanedHeadlines);
      descriptions.splice(0, descriptions.length, ...repaired.cleanedDescriptions);
      if (Array.isArray(callouts)) {
        callouts.splice(0, callouts.length, ...repaired.cleanedCallouts);
      }
      const afterSnapshot = new Set([...(headlines as string[]), ...(descriptions as string[]), ...(Array.isArray(callouts) ? callouts as string[] : [])]);
      // D-161：改动明细回传前端（员工能看到哪些文案被换掉/换成了什么）
      h4AutoFix = {
        criticalCount: finalGate.criticalCount,
        rules: ruleDist,
        rewroteCount: repaired.rewroteCount,
        droppedCount: repaired.droppedCount,
        backfilledCount: repaired.backfilledCount,
        removed: [...beforeSnapshot].filter((t) => !afterSnapshot.has(t)).slice(0, 20),
        added: [...afterSnapshot].filter((t) => !beforeSnapshot.has(t)).slice(0, 20),
      };
      await prisma.ad_creatives.update({
        where: { id: adCreative.id },
        data: { headlines: headlines as any, descriptions: descriptions as any, callouts: callouts as any },
      }).catch((e) => console.warn("[AdSubmit] H4 自动修复写回 DB 失败:", e instanceof Error ? e.message : e));
      console.warn(
        `[AdSubmit] H4 自动修复完成（已放行）：rewrote=${repaired.rewroteCount} dropped=${repaired.droppedCount} backfilled=${repaired.backfilledCount} → headlines=${headlines.length} descriptions=${descriptions.length}`,
      );
    }
    if (finalGate.minorCount > 0) {
      const minors = finalGate.violations.filter((v) => v.severity === "minor");
      const summary = minors.slice(0, 5).map((v) => `${v.field}#${v.index} ${v.rule}`).join("；");
      console.warn(
        `[AdSubmit] D-039 H4 final gate 轻微警告（不阻断 cam=${campaign.id}）：${finalGate.minorCount} 条 minor：${summary}`,
      );
    }
  } catch (h4Err) {
    console.warn(
      "[AdSubmit] D-039 H4 final gate 异常（不阻断提交）:",
      h4Err instanceof Error ? h4Err.message : h4Err,
    );
  }

  // C-088: 用户自定义命名优先（最低 3 项保护：非空、≤120 字符、不能 DRAFT- 前缀）
  // Q3=C 不做撞名/格式校验，留给 Google Ads 处理
  let formalName: string;
  const customNameTrimmed = (bodyCampaignNameCustom || "").trim();
  if (customNameTrimmed) {
    if (customNameTrimmed.length > 120) return apiError("广告系列名过长（最多 120 字符）");
    if (customNameTrimmed.startsWith("DRAFT-")) return apiError("广告系列名不能以 DRAFT- 开头");
    await prisma.campaigns.update({
      where: { id: campaign.id },
      data: { campaign_name: customNameTrimmed },
    });
    formalName = customNameTrimmed;
    console.log(`[AdSubmit] C-088 使用用户自定义命名: "${customNameTrimmed}" (campaign_id=${campaign.id})`);
  } else {
    formalName = await assignFormalCampaignNameBeforeSubmit({
      campaignId: campaign.id,
      userId,
      mccId: mccAccount.id,
      namingRule: submitAdSettings?.naming_rule || "global",
      platformLabel,
      country: campaign.target_country || "US",
      merchantName: submitMerchant.merchant_name || "",
      merchantId: submitMerchant.merchant_id || "",
    });
  }

  const campaignFresh = await prisma.campaigns.findFirst({
    where: { id: campaign.id, user_id: userId, is_deleted: 0 },
  });
  if (!campaignFresh) return apiError("广告系列不存在", 404);

  // 语言代码 → Google Ads 语言常量 ID
  const LANG_CODE_TO_ID: Record<string, string> = {
    en: "1000", de: "1001", fr: "1002", es: "1003", it: "1004",
    ja: "1005", da: "1009", nl: "1010", fi: "1011", ko: "1012",
    no: "1013", pt: "1014", sv: "1015", zh_CN: "1017", zh_TW: "1018",
    ar: "1019", bg: "1020", cs: "1021", el: "1022", hi: "1023",
    hu: "1024", id: "1025", iw: "1027", pl: "1030", ru: "1031",
    ro: "1032", th: "1044", tr: "1037", uk: "1036", vi: "1040",
    ms: "1102",
  };
  // 国家 → 语言 ID（兜底映射）
  const COUNTRY_TO_LANG_ID: Record<string, string> = {
    US: "1000", UK: "1000", GB: "1000", CA: "1000", AU: "1000",
    NZ: "1000", IE: "1000", SG: "1000",
    DE: "1001", AT: "1001", CH: "1001",
    FR: "1002", BE: "1002",
    ES: "1003", MX: "1003", AR: "1003",
    IT: "1004", JP: "1005",
    BR: "1014", PT: "1014",
    NL: "1010", SE: "1015", NO: "1013", DK: "1009",
    FI: "1011", PL: "1030", KR: "1012", IN: "1023",
  };

  const campaignNameToUse = formalName || campaignFresh.campaign_name || `Campaign-${Date.now()}`;
  const countryCode = campaignFresh.target_country?.toUpperCase() || "US";
  const market = getAdMarketConfig(countryCode);

  // 清理同名冲突的辅助函数（使用 remove 操作而非 update status）
  async function removeDuplicateCampaigns() {
    const allCampaigns = await queryGoogleAds(credentials, customerId, `
      SELECT campaign.id, campaign.name, campaign.status
      FROM campaign
      WHERE campaign.status != 'REMOVED'
    `);
    for (const row of allCampaigns) {
      const c = row.campaign as Record<string, unknown> | undefined;
      const name = String(c?.name ?? "");
      const existingId = String(c?.id ?? "");
      if (name === campaignNameToUse && existingId) {
        const rn = `customers/${cid}/campaigns/${existingId}`;
        await mutateGoogleAds(credentials, customerId, [{
          campaign_operation: { remove: rn },
        }]);
        console.log(`[AdSubmit] 已移除同名旧广告: ${name} (ID: ${existingId})`);
      }
    }
  }

  // 真实修复（D-085）：按系列名核对 Google Ads 是否已存在该广告系列（只读、非破坏性）。
  // 用于 mutate 失败后的"状态对账"：很多"CRM 报失败但 Google 已建"的根因是跨草稿重复提交、
  // 或原子批次服务端已 commit 但客户端拿到错误的竞态——只要 Google 端已存在同名系列，
  // 就说明广告其实已提交成功，应采纳同步而非误报失败或删旧重建。
  async function findExistingGoogleCampaign(): Promise<{ id: string; status: string } | null> {
    try {
      const rows = await queryGoogleAds(credentials, customerId, `
        SELECT campaign.id, campaign.name, campaign.status
        FROM campaign
        WHERE campaign.status != 'REMOVED'
      `);
      for (const row of rows) {
        const c = row.campaign as Record<string, unknown> | undefined;
        if (String(c?.name ?? "") === campaignNameToUse && c?.id) {
          return { id: String(c.id), status: String(c?.status ?? "") };
        }
      }
    } catch (e) {
      console.warn("[AdSubmit] 核对已存在广告系列失败（不阻断）:", e instanceof Error ? e.message : e);
    }
    return null;
  }

  // 真实修复（D-085）：状态对账。任何失败路径上报前先调用——若 Google 端已存在同名广告系列，
  // 说明广告其实已提交成功，采纳并同步记录、返回成功响应；否则返回 null 交由原错误逻辑处理。
  // 内层（mutate 失败）与外层（创建成功后持久化失败）catch 都复用，根治整类
  // "CRM 显示失败但 Google 已有广告" 的孤儿/误报。
  async function reconcileIfExistsInGoogle() {
    const existingCampaign = await findExistingGoogleCampaign();
    if (!existingCampaign) return null;
    await prisma.campaigns.update({
      where: { id: campaignFresh!.id },
      data: {
        google_campaign_id: existingCampaign.id,
        customer_id: cid,
        mcc_id: mccAccount!.id,
        platform_connection_id: submitMerchant?.platform_connection_id ?? null,
        google_status: "ENABLED",
      },
    }).catch(() => {});
    try {
      const { syncMerchantStatusForUser } = await import("@/lib/campaign-merchant-link");
      await syncMerchantStatusForUser(userId);
    } catch { /* 同步失败不阻断 */ }
    console.warn(`[AdSubmit] 状态对账：Google 已存在同名广告系列 (ID=${existingCampaign.id}, status=${existingCampaign.status})，采纳并同步，不报失败`);
    const statusNote = existingCampaign.status && existingCampaign.status !== "ENABLED"
      ? `（Google 端系列状态：${existingCampaign.status}）`
      : "";
    return apiSuccess(serializeData({
      google_campaign_id: existingCampaign.id,
      customer_id: customerId,
      campaign_name: campaignNameToUse,
      already_exists: true,
    }), `该广告系列此前已成功提交到 Google Ads，已同步记录${statusNote}。如广告未投放，请在 Google Ads 后台查看审核/政策状态并按需修改或申诉。`);
  }

  try {
    const operations: Record<string, unknown>[] = [];

    const budgetTempRn = `customers/${cid}/campaignBudgets/-1`;
    const campaignTempRn = `customers/${cid}/campaigns/-2`;
    const adGroupTempRn = `customers/${cid}/adGroups/-3`;

    // ─── 1. CampaignBudget（独立预算，非共享） ───
    operations.push({
      campaign_budget_operation: {
        create: {
          resource_name: budgetTempRn,
          name: `Budget-${campaignNameToUse}-${Date.now()}`,
          amount_micros: String(dollarsToMicros(daily_budget)),
          delivery_method: "STANDARD",
          explicitly_shared: false,
        },
      },
    });

    // ─── 2. Campaign ───
    const biddingConfig = bidding_strategy === "MANUAL_CPC"
      ? { manual_cpc: { enhanced_cpc_enabled: true } }
      : bidding_strategy === "TARGET_CPA"
        ? { target_cpa: { target_cpa_micros: String(dollarsToMicros(max_cpc_limit * 10)) } }
        : { target_spend: { cpc_bid_ceiling_micros: String(dollarsToMicros(max_cpc_limit)) } };

    const euPoliticalValue = eu_political_ad === 1
      ? "CONTAINS_EU_POLITICAL_ADVERTISING"
      : "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING";

    // 最终到达网址后缀：优先使用前端传入值，其次取 DB 中保存的值
    const rawFinalUrlSuffix: string | undefined =
      (bodyFinalUrlSuffix ?? ((campaign as any).final_url_suffix as string | null) ?? undefined) || undefined;
    // D-157：Google Ads 要求 final_url_suffix 是合法 query string，**不能以 '?' 或 '&' 开头**（否则 INVALID_ARGUMENT，
    // 报 "The final url suffix cannot begin with '?' or '&'…"）。前端/联盟后缀常带前导 '?'（如 ?utm_source=...&clickId=...），
    // 这里统一剥掉前导 ?/& 与首尾空白、去掉尾部多余 &，兼容已存库的脏值。
    let finalUrlSuffix: string | undefined = rawFinalUrlSuffix
      ? (rawFinalUrlSuffix.trim().replace(/^[?&\s]+/, "").replace(/[?&\s]+$/, "").trim() || undefined)
      : undefined;
    // 后缀里出现协议头 = 有人把整条追踪链接贴进了后缀（历史脏数据/误操作）。
    // 送到 Google 会拼出「落地页?https://...」的废到达页，宁可不带后缀也不能带废后缀。
    if (finalUrlSuffix && (finalUrlSuffix.includes("://") || /^https?[:%]/i.test(finalUrlSuffix))) {
      console.warn(`[AdSubmit] final_url_suffix 疑似整条链接，已丢弃不上传: ${finalUrlSuffix.slice(0, 100)}`);
      finalUrlSuffix = undefined;
    }

    operations.push({
      campaign_operation: {
        create: {
          resource_name: campaignTempRn,
          name: campaignNameToUse,
          advertising_channel_type: "SEARCH",
          status: "ENABLED",
          campaign_budget: budgetTempRn,
          ...biddingConfig,
          network_settings: {
            target_google_search: network_search,
            target_search_network: network_partners,
            target_content_network: network_display,
            target_partner_search_network: false,
          },
          // D-015: 地理位置定位类型 = "所在地"（PRESENCE）
          // 默认 PRESENCE_OR_INTEREST 会把"对该地区表现出兴趣"的用户也算进去，预算会被分散到非目标人群
          // PRESENCE 仅匹配真实位于该地理位置的用户，对联盟营销 ROI 更准、更可控
          geo_target_type_setting: {
            positive_geo_target_type: "PRESENCE",
            negative_geo_target_type: "PRESENCE",
          },
          contains_eu_political_advertising: euPoliticalValue,
          ...(finalUrlSuffix ? { final_url_suffix: finalUrlSuffix } : {}),
        },
      },
    });

    // ─── 3. 地理定向 ───
    const geoTargetMap: Record<string, string> = {
      US: "2840", UK: "2826", GB: "2826", CA: "2124", AU: "2036",
      DE: "2276", FR: "2250", JP: "2392", BR: "2076", IT: "2380",
      ES: "2724", NL: "2528", SE: "2752", NO: "2578", DK: "2208",
      FI: "2246", PL: "2616", AT: "2040", CH: "2756", BE: "2056",
      IE: "2372", PT: "2620", NZ: "2554", SG: "2702", KR: "2410",
      IN: "2356", MX: "2484",
    };
    const geoId = geoTargetMap[countryCode] || "2840";
    operations.push({
      campaign_criterion_operation: {
        create: {
          campaign: campaignTempRn,
          location: { geo_target_constant: `geoTargetConstants/${geoId}` },
        },
      },
    });

    // ─── 4. 语言定向（优先用户选择的语言，兜底按国家推断）───
    const langId = (ad_language && LANG_CODE_TO_ID[ad_language])
      || COUNTRY_TO_LANG_ID[countryCode]
      || "1000";
    operations.push({
      campaign_criterion_operation: {
        create: {
          campaign: campaignTempRn,
          language: { language_constant: `languageConstants/${langId}` },
        },
      },
    });

    // ─── 5. AdGroup ───  (index = 4)
    operations.push({
      ad_group_operation: {
        create: {
          resource_name: adGroupTempRn,
          name: adGroup.ad_group_name || campaignNameToUse || `AdGroup-${Date.now()}`,
          campaign: campaignTempRn,
          type: "SEARCH_STANDARD",
          cpc_bid_micros: String(dollarsToMicros(max_cpc_limit)),
          status: "ENABLED",
        },
      },
    });

    // ─── 6. RSA 广告 ───
    // C-148：文案"贴合限长"——超长一律 AI 语义压缩成完整短语，AI 失败按词边界回退，
    // 绝不再用 .slice() 从单词中间硬切（旧逻辑会把超长标题/描述切成半截词上线）。
    const adTextLang = market.languageCode || "English";
    const fittedHeadlines = await fitAdTextBatch(
      (headlines as string[]).slice(0, 15).map((h) => sanitizeAdText(h, { allowExclamation: true })),
      30,
      adTextLang,
    );
    const headlineAssets = fittedHeadlines
      .map((text: string) => ({ text }))
      .filter((h: { text: string }, i: number, arr: { text: string }[]) =>
        h.text.length > 0 && arr.findIndex((x) => x.text.toLowerCase() === h.text.toLowerCase()) === i
      );
    const fittedDescriptions = await fitAdTextBatch(
      (descriptions as string[]).slice(0, 4).map((d) => sanitizeAdText(d, { allowExclamation: true })),
      90,
      adTextLang,
    );
    const descriptionAssets = fittedDescriptions
      .map((text: string) => ({ text }))
      .filter((d: { text: string }, i: number, arr: { text: string }[]) =>
        d.text.length > 0 && arr.findIndex((x) => x.text.toLowerCase() === d.text.toLowerCase()) === i
      );

    const rsaInfo: Record<string, unknown> = {
      headlines: headlineAssets,
      descriptions: descriptionAssets,
    };
    if (adCreative.display_path1) rsaInfo.path1 = adCreative.display_path1;
    if (adCreative.display_path2) rsaInfo.path2 = adCreative.display_path2;

    operations.push({
      ad_group_ad_operation: {
        create: {
          ad_group: adGroupTempRn,
          status: "ENABLED",
          ad: {
            responsive_search_ad: rsaInfo,
            final_urls: [finalUrl],
          },
        },
      },
    });

    // ─── 7. 关键词（政策风险词硬拦截，不发送给 Google） ───
    const seenKeywords = new Set<string>();
    // 记录真正进入 operations 的关键字，供成功后回写 DB（让 keywords 表成为可信真相来源）
    const submittedKeywords: { text: string; matchType: string }[] = [];
    for (const kw of effectiveKeywords) {
      // 2026-07-13（第六轮）：Google Ads 关键词非法字符清洗（! @ % ^ 等一个字符就能让
      // 整批 mutate 被 KeywordPlanError/CRITERION_ERROR 拒绝）。清洗后过短的直接跳过。
      const rawText = typeof kw === "string" ? kw : kw.text;
      const text = rawText.replace(/[!@%^*;~`<>()[\]{}|\\"=,?]/g, " ").replace(/\s+/g, " ").trim();
      if (text.length < 2) {
        console.warn(`[AdSubmit] 关键词清洗后过短，跳过: "${rawText}"`);
        continue;
      }
      if (isPolicyRiskKeyword(text)) {
        console.warn(`[AdSubmit] 拦截政策风险关键词，不提交: "${text}"`);
        continue;
      }
      const rawMatch = typeof kw === "string" ? "PHRASE" : (kw.matchType || "PHRASE");
      const matchType = rawMatch.toUpperCase();
      const kwKey = `${text.toLowerCase()}|${matchType}`;
      if (seenKeywords.has(kwKey)) continue;
      seenKeywords.add(kwKey);
      submittedKeywords.push({ text, matchType });
      operations.push({
        ad_group_criterion_operation: {
          create: {
            ad_group: adGroupTempRn,
            status: "ENABLED",
            keyword: { text, match_type: matchType },
          },
        },
      });
    }
    // 兜底后关键字仍被政策风险词全部过滤 → 同样是「零可投放关键字」，直接拒绝提交，
    // 不制造无关键字的无效系列。
    if (submittedKeywords.length === 0) {
      return apiError(
        "该广告系列的关键字均被政策风险过滤，提交后将没有可投放关键字。请更换或新增合规关键字后再提交。",
        422,
      );
    }

    // ─── 8. Sitelink 扩展（标题/描述需符合 Google Ads 大写和标点规范） ───
    // C-148：站点链接标题/描述同样走"贴合限长"，绝不从词中间硬切。
    const slTitlesFitted = await fitAdTextBatch(
      (sitelinks as any[]).map((sl) => sanitizeAdText((sl.title || ""), { allowExclamation: false })),
      25,
      adTextLang,
    );
    const slDesc1Fitted = await fitAdTextBatch(
      (sitelinks as any[]).map((sl) => sanitizeAdText((sl.description1 || ""), { allowExclamation: true })),
      35,
      adTextLang,
    );
    const slDesc2Fitted = await fitAdTextBatch(
      (sitelinks as any[]).map((sl) => sanitizeAdText((sl.description2 || ""), { allowExclamation: true })),
      35,
      adTextLang,
    );
    let assetTempId = -10;
    const seenSitelinkTexts = new Set<string>();
    for (let slIdx = 0; slIdx < (sitelinks as any[]).length; slIdx++) {
      const sl = (sitelinks as any[])[slIdx];
      const assetTempRn = `customers/${cid}/assets/${assetTempId}`;
      let slUrl = (sl.finalUrl || "").trim();
      if (slUrl.startsWith("http://")) slUrl = slUrl.replace("http://", "https://");
      const linkText = slTitlesFitted[slIdx];
      const desc1Raw = slDesc1Fitted[slIdx];
      const desc2Raw = slDesc2Fitted[slIdx];

      // 安全校验：link_text 为空或 URL 无效则跳过该站内链接
      if (!linkText || !slUrl.startsWith("https://")) {
        console.warn(`[AdSubmit] 跳过无效站内链接: title="${sl.title}", url="${slUrl}"`);
        continue;
      }
      const slKey = linkText.toLowerCase();
      if (seenSitelinkTexts.has(slKey)) {
        console.warn(`[AdSubmit] 跳过重复站内链接: "${linkText}"`);
        continue;
      }
      seenSitelinkTexts.add(slKey);

      // Google Ads API v23: description1 和 description2 必须同时有值（1-35 字符），
      // 否则必须同时省略。空字符串在 proto3 中视为"未设置"，会触发 REQUIRED 错误。
      const sitelinkAssetPayload: Record<string, unknown> = { link_text: linkText };
      if (desc1Raw.length >= 1 && desc2Raw.length >= 1) {
        sitelinkAssetPayload.description1 = desc1Raw;
        sitelinkAssetPayload.description2 = desc2Raw;
      } else if (desc1Raw.length >= 1) {
        // desc2 为空时用 link_text 按词边界补全，保证二者同时存在
        sitelinkAssetPayload.description1 = desc1Raw;
        sitelinkAssetPayload.description2 = fitAdTextSync(linkText, 35);
      } else if (desc2Raw.length >= 1) {
        sitelinkAssetPayload.description1 = fitAdTextSync(linkText, 35);
        sitelinkAssetPayload.description2 = desc2Raw;
      }
      // 两者均为空时不包含，API 允许省略描述

      operations.push({
        asset_operation: {
          create: {
            resource_name: assetTempRn,
            final_urls: [slUrl],
            sitelink_asset: sitelinkAssetPayload,
          },
        },
      });
      operations.push({
        campaign_asset_operation: {
          create: {
            asset: assetTempRn,
            campaign: campaignTempRn,
            field_type: "SITELINK",
          },
        },
      });
      assetTempId--;
    }

    // ─── 9. Callout 扩展（服务端校验：callout 必须 ≥ 2 条、每条 2-25 字符） ───
    // C-148：宣传信息走"贴合限长"，超长 AI 压缩/词边界回退，不再 .slice 硬切
    const fittedCallouts = await fitAdTextBatch(
      (callouts as string[]).map((c) => sanitizeAdText((c || ""), { allowExclamation: false })),
      25,
      adTextLang,
    );
    const validCallouts = fittedCallouts
      .filter((c: string) => c.length >= 2)
      .filter((c: string, i: number, arr: string[]) =>
        arr.findIndex((x) => x.toLowerCase() === c.toLowerCase()) === i
      );
    if (validCallouts.length > 0 && validCallouts.length < 2) {
      console.warn(`[AdSubmit] Callout 不足2条（${validCallouts.length}条），Google Ads 要求至少2条才能展示，跳过提交`);
    }
    const calloutsToSubmit = validCallouts.length >= 2 ? validCallouts : [];
    for (const calloutText of calloutsToSubmit) {
      const cleanCallout = calloutText;
      // callout_text 为必填项（2-25 字符），空文本直接跳过
      if (!cleanCallout) continue;
      const assetTempRn = `customers/${cid}/assets/${assetTempId}`;
      operations.push({
        asset_operation: {
          create: {
            resource_name: assetTempRn,
            callout_asset: {
              callout_text: cleanCallout,
            },
          },
        },
      });
      operations.push({
        campaign_asset_operation: {
          create: {
            asset: assetTempRn,
            campaign: campaignTempRn,
            field_type: "CALLOUT",
          },
        },
      });
      assetTempId--;
    }

    // ─── 9b. 促销扩展 (Promotion) — 服务端校验 occasion 枚举 ───
    const VALID_PROMOTION_OCCASIONS = new Set([
      "BACK_TO_SCHOOL", "BLACK_FRIDAY", "CHRISTMAS", "CYBER_MONDAY",
      "EASTER", "FATHERS_DAY", "HALLOWEEN", "MOTHERS_DAY",
      "NEW_YEARS", "THANKSGIVING", "VALENTINES_DAY", "NONE",
    ]);
    const hasValidDiscount =
      (promotion?.discount_type === "PERCENT" && Number(promotion?.discount_percent) > 0) ||
      (promotion?.discount_type === "MONETARY" && Number(promotion?.discount_amount) > 0);
    if (promotion?.promotion_target && hasValidDiscount) {
      const assetTempRn = `customers/${cid}/assets/${assetTempId}`;
      const promotionAsset: Record<string, unknown> = {
        promotion_target: fitAdTextSync(promotion.promotion_target || "", 20),
        language_code: promotion.language_code || market.promotionLanguageCode,
      };
      if (promotion.discount_type === "PERCENT") {
        const pct = Math.min(Math.max(Number(promotion.discount_percent) || 0, 1), 100);
        promotionAsset.percent_off = pct * 10_000;
      } else {
        const rawMicros = Math.round(Math.abs(Number(promotion.discount_amount) || 0) * 1_000_000);
        const centAligned = Math.round(rawMicros / 10_000) * 10_000;
        promotionAsset.money_amount_off = {
          amount_micros: String(Math.max(centAligned, 10_000)),
          currency_code: promotion.currency_code || market.currencyCode,
        };
      }
      if (promotion.promo_code) {
        promotionAsset.promotion_code = promotion.promo_code;
        // orders_over_amount 只有在没有 promo_code 时才能设置
      } else if (promotion.orders_over_amount && Number(promotion.orders_over_amount) > 0) {
        const ordersOverMicros = Math.round(Number(promotion.orders_over_amount) * 1_000_000);
        promotionAsset.orders_over_amount = {
          amount_micros: String(ordersOverMicros),
          currency_code: promotion.currency_code || market.currencyCode,
        };
      }
      // occasion 枚举校验：无效值替换为 NONE（不传 occasion 字段以避免 API 拒绝）
      if (promotion.occasion) {
        const upperOccasion = String(promotion.occasion).toUpperCase().replace(/ /g, "_");
        if (VALID_PROMOTION_OCCASIONS.has(upperOccasion) && upperOccasion !== "NONE") {
          promotionAsset.occasion = upperOccasion;
        }
      }
      if (promotion.start_date) promotionAsset.start_date = promotion.start_date;
      if (promotion.end_date) promotionAsset.end_date = promotion.end_date;

      const promoFinalUrl = (promotion.final_url || finalUrl || "").trim();
      operations.push({
        asset_operation: {
          create: {
            resource_name: assetTempRn,
            promotion_asset: promotionAsset,
            final_urls: [promoFinalUrl],
          },
        },
      });
      operations.push({
        campaign_asset_operation: {
          create: {
            asset: assetTempRn,
            campaign: campaignTempRn,
            field_type: "PROMOTION",
          },
        },
      });
      assetTempId--;
    }

    // ─── 9c. 价格扩展 (Price) — 服务端校验：至少需要 3 条产品项 ───
    if (price?.items?.length > 0 && price.items.length < 3) {
      console.warn(`[AdSubmit] Price Extension 仅有 ${price.items.length} 条，Google Ads 要求至少3条，跳过提交`);
    }
    if (price?.items?.length >= 3) {
      const VALID_PRICE_UNITS = new Set([
        "PER_HOUR", "PER_DAY", "PER_WEEK", "PER_MONTH", "PER_YEAR", "PER_NIGHT",
      ]);
      // C-148：价格组件 header/description 走"贴合限长"，不再 .slice 硬切
      const fittedPriceHeaders = await fitAdTextBatch(
        (price.items as any[]).map((it) => String(it.header || "")),
        25,
        adTextLang,
      );
      const fittedPriceDescs = await fitAdTextBatch(
        (price.items as any[]).map((it) => String(it.description || "")),
        25,
        adTextLang,
      );
      const seenPriceHeaders = new Set<string>();
      const priceOfferings = price.items
        .map((item: any, pIdx: number) => {
          const header = fittedPriceHeaders[pIdx];
          const headerKey = header.toLowerCase();
          if (!header || seenPriceHeaders.has(headerKey)) return null;
          seenPriceHeaders.add(headerKey);
          let description = fittedPriceDescs[pIdx];
          // Google Ads 硬规则：PriceOffering header 和 description 不能相同
          if (description.toLowerCase() === header.toLowerCase() || !description) {
            description = `Shop ${header}`.length <= 25 ? `Shop ${header}` : "View details";
            if (description.toLowerCase() === header.toLowerCase()) description = "View details";
          }
          const offering: Record<string, unknown> = {
            header,
            description,
            price: {
              amount_micros: String(Math.round((item.price_amount || 0) * 1_000_000)),
              currency_code: item.currency_code || market.currencyCode,
            },
          };
          if (item.unit && VALID_PRICE_UNITS.has(item.unit)) {
            offering.unit = item.unit;
          }
          let itemUrl = (item.final_url || item.url || "").trim();
          try {
            if (itemUrl && new URL(itemUrl).hostname.replace(/^www\./, "") !== new URL(finalUrl).hostname.replace(/^www\./, "")) {
              itemUrl = "";
            }
          } catch { itemUrl = ""; }
          offering.final_url = itemUrl || finalUrl;
          return offering;
        })
        .filter(Boolean);
      if (priceOfferings.length < 3) {
        console.warn(`[AdSubmit] Price Extension 去重后仅 ${priceOfferings.length} 条，不足3条，跳过提交`);
      } else {
        const assetTempRn = `customers/${cid}/assets/${assetTempId}`;
        operations.push({
          asset_operation: {
            create: {
              resource_name: assetTempRn,
              price_asset: {
                type: price.type || "BRANDS",
                language_code: market.priceLanguageCode,
                price_offerings: priceOfferings,
              },
            },
          },
        });
        operations.push({
          campaign_asset_operation: {
            create: {
              asset: assetTempRn,
              campaign: campaignTempRn,
              field_type: "PRICE",
            },
          },
        });
        assetTempId--;
      }
    }

    // ─── 9d. 致电扩展 (Call) ───
    // D-162：提交前电话校验改为与爬虫端同源（crawl-pipeline.isValidPhoneForCountry，NANP 严格规则）。
    // 旧实现是独立的宽松版（US 只查位数），价格误提取/假号全放行 → 近14天 60 次
    // CALL_PHONE_NUMBER_NOT_SUPPORTED_FOR_COUNTRY 拒登，占全部拒登 63%。
    const { isValidPhoneForCountry } = await import("@/lib/crawl-pipeline");
    const isPhoneValidForCountry = (phone: string, country: string): boolean =>
      isValidPhoneForCountry(phone, (country || "US").toUpperCase().replace("UK", "GB"));
    if (callExtension?.phone_number && isPhoneValidForCountry(callExtension.phone_number, countryCode)) {
      const assetTempRn = `customers/${cid}/assets/${assetTempId}`;
      operations.push({
        asset_operation: {
          create: {
            resource_name: assetTempRn,
            call_asset: {
              country_code: callExtension.country_code || countryCode,
              phone_number: callExtension.phone_number,
              call_conversion_reporting_state: "DISABLED",
            },
          },
        },
      });
      operations.push({
        campaign_asset_operation: {
          create: {
            asset: assetTempRn,
            campaign: campaignTempRn,
            field_type: "CALL",
          },
        },
      });
      assetTempId--;
    } else if (callExtension?.phone_number && !isPhoneValidForCountry(callExtension.phone_number, countryCode)) {
      console.warn(`[Submit] Call 扩展跳过：电话 "${callExtension.phone_number}" 格式与目标国家 "${countryCode}" 不匹配`);
    }

    // ─── 9e. 结构化摘要 (Structured Snippet) ───
    // C-148：摘要值走"贴合限长"，不再 .slice 硬切
    const fittedSnippetValues = await fitAdTextBatch(
      (structured_snippet?.values || []).slice(0, 10).map((v: string) => String(v || "")),
      25,
      adTextLang,
    );
    const snippetValues = fittedSnippetValues
      .filter((v: string) => v.length > 0)
      .filter((v: string, i: number, arr: string[]) =>
        arr.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === i
      );
    if (snippetValues.length >= 3) {
      const assetTempRn = `customers/${cid}/assets/${assetTempId}`;
      operations.push({
        asset_operation: {
          create: {
            resource_name: assetTempRn,
            structured_snippet_asset: {
              header: structured_snippet.header || market.snippetHeader,
              values: snippetValues,
            },
          },
        },
      });
      operations.push({
        campaign_asset_operation: {
          create: {
            asset: assetTempRn,
            campaign: campaignTempRn,
            field_type: "STRUCTURED_SNIPPET",
          },
        },
      });
      assetTempId--;
    }

    // ─── 9f. 否定关键词 (Negative Keywords) — 系列级别 ───
    // 2026-07-13（第六轮）：
    //   ① 剔除 Google Ads 关键词非法字符（! @ % ^ 等，API 会整批 mutate 拒绝）；
    //   ② 品牌保护——AI 否定词若命中商家品牌词根，直接丢弃（否掉自家品牌 = 自断流量）；
    //   ③ 正选词保护——否定词是任一正选关键词的子串/相等时丢弃（BROAD 否定含正选词
    //     的子词会把自己的正选流量全部拦死）。
    const { extractBrandRoot: extractBrandRootForNeg } = await import("@/lib/country-url-resolver");
    const brandRootForNeg = extractBrandRootForNeg(submitMerchant?.merchant_name || "").toLowerCase();
    const positiveKwTexts = effectiveKeywords
      .map((k) => (typeof k === "string" ? k : k.text || "").trim().toLowerCase())
      .filter(Boolean);
    const validNegativeKws: string[] = Array.isArray(negative_keywords)
      ? negative_keywords
          .map((k: string) => String(k || "").replace(/[!@%^*;~`<>()[\]{}|\\"=]/g, " ").replace(/\s+/g, " ").trim().toLowerCase())
          .filter((k: string) => k.length >= 2 && k.length <= 80)
          .filter((k: string) => {
            if (brandRootForNeg && brandRootForNeg.length >= 3 && (k.includes(brandRootForNeg) || brandRootForNeg.includes(k))) {
              console.warn(`[AdSubmit] 否定词命中品牌保护，剔除: "${k}" (brand=${brandRootForNeg})`);
              return false;
            }
            const hit = positiveKwTexts.find((p) => p === k || p.includes(k));
            if (hit) {
              console.warn(`[AdSubmit] 否定词与正选关键词冲突，剔除: "${k}" (positive="${hit}")`);
              return false;
            }
            return true;
          })
          .slice(0, 20)
      : [];
    for (const kwText of validNegativeKws) {
      operations.push({
        campaign_criterion_operation: {
          create: {
            campaign: campaignTempRn,
            negative: true,
            keyword: {
              text: kwText,
              match_type: "BROAD",
            },
          },
        },
      });
    }
    if (validNegativeKws.length > 0) {
      console.log(`[AdSubmit] 否定关键词: ${validNegativeKws.length} 条`);
    }

    // ─── 发送批量 Mutate 请求（含 DUPLICATE_CAMPAIGN_NAME / POLICY_ERROR 自动重试） ───
    let result: Record<string, unknown>;
    let skippedKeywords: string[] = [];
    // D-152：记录 Google 拒登后 AI 自动改写的明细，成功时回传给前端，让员工知道文案被自动修过
    const aiPolicyFixNotes: string[] = [];
    try {
      result = await mutateGoogleAds(credentials, customerId, operations) as Record<string, unknown>;
    } catch (mutateErr) {
      const errMsg = mutateErr instanceof Error ? mutateErr.message : String(mutateErr);

      // ─── 真实修复（D-085）：状态对账优先于任何错误上报 ───
      // mutate 抛错后，Google 端可能其实已存在该广告系列（跨草稿重复提交、或原子批次服务端
      // 已 commit 但客户端拿到错误等竞态）。无论错误类型，先按系列名核对：已存在 = 广告其实
      // 已发到 Google，直接采纳并同步记录、如实返回，杜绝"CRM 显示失败但 Google 已有广告"。
      {
        const reconciled = await reconcileIfExistsInGoogle();
        if (reconciled) return reconciled;
      }

      if (errMsg.includes("DUPLICATE_CAMPAIGN_NAME")) {
        console.log("[AdSubmit] 检测到同名冲突，强制清理后重试...");
        await removeDuplicateCampaigns();
        try {
          result = await mutateGoogleAds(credentials, customerId, operations) as Record<string, unknown>;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          const canFallThrough = retryMsg.includes("POLICY_ERROR")
            || retryMsg.includes("policyViolationError")
            || retryMsg.includes("assetError")
            || retryMsg.includes("INVALID_ARGUMENT");
          if (!canFallThrough) throw retryErr;
          Object.assign(mutateErr as Error, { message: retryMsg });
        }
      }

      // Handle policy violations or asset errors: remove violating operations and retry
      // NOTE: mutateErr.message may already be transformed to Chinese (via formatGoogleAdsErrorMessage),
      // so we MUST also check violations[] and rawBody for policy/prohibited keywords.
      const finalMsg = mutateErr instanceof Error ? mutateErr.message : String(mutateErr);
      const errViolations = (mutateErr as any)?.violations as GoogleAdsViolation[] | undefined;
      const rawErrBody = (mutateErr as any)?.rawBody as string | undefined;

      // ─── D-041 Policy Hub：提前深度解析 PolicyViolationDetails ───
      // 把 -2/-3/1731343072 之类的级联失败标识过滤掉，
      // 解析出真正的 policyName + violatingText + 可读字段（如「标题3」），
      // 后续 throw 用 parsedPolicyError.readableMessage 替代旧的拼字符串。
      const parsedPolicyError: ParsedPolicyError | null = rawErrBody
        ? parsePolicyError(rawErrBody)
        : null;
      // 写入 policy_violations 表（不阻塞主流程：写表失败仅 console.warn）
      if (parsedPolicyError && parsedPolicyError.primary.length > 0) {
        try {
          await logPolicyViolations(parsedPolicyError, {
            campaign_id: campaign.id,
            user_merchant_id: campaign.user_merchant_id,
            user_id: userId,
            mcc_id: mccAccount.id,
            google_customer_id: cid,
            campaign_name: campaign.campaign_name,
            merchant_domain: finalUrl ? new URL(finalUrl).hostname : null,
            country: campaign.target_country,
          });
        } catch (logErr) {
          console.warn("[AdSubmit] D-041 logPolicyViolations 失败（不影响广告流程）:", logErr instanceof Error ? logErr.message : logErr);
        }
      }

      const hasViolationRetriable = errViolations?.some((v) =>
        v.errorCode.toLowerCase().includes("policy")
        || v.errorCode.toLowerCase().includes("prohibited")
        || v.message.toLowerCase().includes("disapproved")
        || v.message.toLowerCase().includes("prohibited")
        || v.message.toLowerCase().includes("policy")
      ) ?? false;
      const hasRawBodyRetriable = !!(rawErrBody && (
        rawErrBody.includes("POLICY_ERROR")
        || rawErrBody.includes("policyViolationError")
        || rawErrBody.includes("PROHIBITED")
        || rawErrBody.includes("disapproved")
        || rawErrBody.includes("assetError")
        || rawErrBody.includes("INVALID_ARGUMENT")
      ));

      const isRetriableError = finalMsg.includes("POLICY_ERROR")
        || finalMsg.includes("policyViolationError")
        || finalMsg.includes("assetError")
        || finalMsg.includes("CALL_PHONE_NUMBER_NOT_SUPPORTED_FOR_COUNTRY")
        || finalMsg.includes("INVALID_ARGUMENT")
        || finalMsg.includes("PROHIBITED")
        || finalMsg.includes("disapproved")
        || hasViolationRetriable
        || hasRawBodyRetriable;
      if (isRetriableError) {
        console.log("[AdSubmit] 检测到可恢复错误，尝试移除违规操作后重试...");
        // D-156：打印「首个错误原始体」（重试前）——旧逻辑只在最外层 catch 记录最终错误，
        // 第一次全量 mutate 的真错误会被本 catch 吞掉走重试，导致根因不可见、只看到被污染的级联错误。
        console.warn(`[AdSubmit] D-156 首个错误原始体（重试前，用于定位真因）: ${(rawErrBody || finalMsg).slice(0, 1500)}`);
        // Parse violating indices: prefer rawBody (raw JSON) > transformed message > violations[].operationIndex
        let violatingIndices = parsePolicyViolationIndices(finalMsg);
        if (violatingIndices.size === 0 && rawErrBody) {
          violatingIndices = parsePolicyViolationIndices(rawErrBody);
        }
        if (violatingIndices.size === 0 && errViolations?.length) {
          for (const v of errViolations) {
            if (v.operationIndex != null) violatingIndices.add(v.operationIndex);
          }
        }

        if (violatingIndices.size > 0) {
          const skippedDetails: string[] = [];
          for (const idx of violatingIndices) {
            const op = operations[idx] as any;
            const kwText = op?.ad_group_criterion_operation?.create?.keyword?.text;
            if (kwText) { skippedKeywords.push(kwText); skippedDetails.push(`关键词: ${kwText}`); }
            else if (op?.asset_operation?.create?.call_asset) skippedDetails.push("致电扩展");
            else if (op?.campaign_asset_operation) skippedDetails.push("关联资源");
            else if (op?.ad_group_ad_operation) skippedDetails.push("RSA广告素材");
            else skippedDetails.push(`操作[${idx}]`);
          }

          // RSA 广告（ad_group_ad_operation）固定在 index 5，是核心操作，不能被移除。
          // 若广告本身触发政策违规，必须直接报错让用户修改文案，不能静默跳过导致
          // Google 上只有广告系列+广告组、没有广告的"空壳"状态。
          const RSA_AD_INDEX = 5;
          if (violatingIndices.has(RSA_AD_INDEX)) {
            // ─── D-152：广告文案被 Google 拒登 → 自动「被拒文案 + Google 拒登原因」喂给 AI 改写后重提 ───
            // 取代旧的「直接 throw 让员工人工改」。本地规则违规早有 AI 自动改写（generate-more），
            // 这里把 Google 真实拒登也接入同一条 AI 修复闭环。最多 N 轮；AI 改不动 / 改后仍被拒 → 回落人工提示。
            const MAX_AI_POLICY_ROUNDS = 2;
            // D-156：随 RSA 重提一并丢弃的「非 RSA 违规操作」只能是 index>5 的可选附加（关键词/扩展/图片）。
            // 基础骨架 budget0/campaign1/geo2/lang3/adGroup4 通过临时资源名 -1/-2/-3 互相引用，删任何一个都会让
            // RSA 广告引用的 adGroups/-3 悬空 → RESOURCE_NOT_FOUND 自残式级联。故用 i>RSA_AD_INDEX 而非 i!==RSA_AD_INDEX。
            const nonRsaViolating = new Set<number>([...violatingIndices].filter((i) => i > RSA_AD_INDEX));
            const aiFixNotes: string[] = [];
            let lastParsed: ParsedPolicyError | null = parsedPolicyError;
            let aiFixed = false;
            for (let round = 1; round <= MAX_AI_POLICY_ROUNDS && !result!; round++) {
              const rw = await rewriteAdCopyForPolicy({
                headlines: headlines as string[],
                descriptions: descriptions as string[],
                parsed: lastParsed,
                merchantName: (submitMerchant as { merchant_name?: string })?.merchant_name || campaign.campaign_name || "",
                languageName: adTextLang,
              });
              if (!rw.changed) break; // AI 无法改写 → 退出，走人工回落
              // 写回本地变量：成功后会把 headlines/descriptions 落库，须与实际提交一致
              (headlines as string[]).splice(0, (headlines as string[]).length, ...rw.headlines);
              (descriptions as string[]).splice(0, (descriptions as string[]).length, ...rw.descriptions);
              aiFixNotes.push(...rw.notes);

              // 用改写后的文案重建 RSA 操作（贴合限长 + 去重，与首次构造同口径）
              const rhFit = await fitAdTextBatch((headlines as string[]).slice(0, 15).map((h) => sanitizeAdText(h, { allowExclamation: true })), 30, adTextLang);
              const rhAssets = rhFit.map((text: string) => ({ text })).filter((h, i, arr) => h.text.length > 0 && arr.findIndex((x) => x.text.toLowerCase() === h.text.toLowerCase()) === i);
              const rdFit = await fitAdTextBatch((descriptions as string[]).slice(0, 4).map((d) => sanitizeAdText(d, { allowExclamation: true })), 90, adTextLang);
              const rdAssets = rdFit.map((text: string) => ({ text })).filter((d, i, arr) => d.text.length > 0 && arr.findIndex((x) => x.text.toLowerCase() === d.text.toLowerCase()) === i);
              const newRsaInfo: Record<string, unknown> = { ...rsaInfo, headlines: rhAssets, descriptions: rdAssets };
              // 同时丢弃其它非 RSA 的违规操作（关键词/资源），与 filteredOps 同策略；
              // 被丢弃的均在 index>5（关键词/扩展在 RSA 之后 push），不影响 0~5 的响应解析顺序。
              const retryOps = operations
                .map((op, i) => (i === RSA_AD_INDEX
                  ? { ad_group_ad_operation: { create: { ad_group: adGroupTempRn, status: "ENABLED", ad: { responsive_search_ad: newRsaInfo, final_urls: [finalUrl] } } } }
                  : op))
                .filter((_, i) => !nonRsaViolating.has(i));

              console.log(`[AdSubmit] D-152 AI 政策改写第 ${round}/${MAX_AI_POLICY_ROUNDS} 轮，改写 ${rw.notes.length} 处后重提`);
              try {
                result = await mutateGoogleAds(credentials, customerId, retryOps) as Record<string, unknown>;
                aiFixed = true;
                aiPolicyFixNotes.push(...aiFixNotes);
                console.log(`[AdSubmit] D-152 AI 改写后重提成功：\n${aiFixNotes.join("\n")}`);
              } catch (reErr) {
                const reBody = (reErr as { rawBody?: string })?.rawBody;
                const reMsg = reErr instanceof Error ? reErr.message : String(reErr);
                const stillPolicy = !!(reBody && (reBody.includes("POLICY_ERROR") || reBody.includes("policyViolationError") || reBody.includes("PROHIBITED") || reBody.includes("disapproved")))
                  || reMsg.includes("POLICY_ERROR") || reMsg.includes("PROHIBITED") || reMsg.includes("disapproved");
                if (!stillPolicy) throw reErr; // 新错误非政策类（配额/参数等）→ 交外层处理
                lastParsed = reBody ? parsePolicyError(reBody) : null; // 带新一轮原因继续改
              }
            }

            if (!aiFixed) {
              // 回落人工提示（保留 D-041 逻辑），并附上已尝试的 AI 改写明细
              const readable = parsedPolicyError?.readableMessage;
              const prefix = aiFixNotes.length > 0
                ? `Google Ads 拒登广告，已自动用 AI 改写文案重试仍未通过，请人工修改。\n已尝试改写：\n${aiFixNotes.join("\n")}\n\n`
                : "";
              if (readable && readable.trim().length > 0) {
                throw new Error(`${prefix}${readable}`);
              }
              const campaignNm = (campaign.campaign_name || "").trim();
              const adTextTriggers = Array.from(new Set(
                (errViolations || [])
                  .map((v) => (v.trigger || "").trim())
                  .filter((t) => t && !/^-?\d+$/.test(t) && t !== campaignNm && !skippedKeywords.includes(t)),
              ));
              const triggerHint = adTextTriggers.length > 0
                ? `（疑似触发词：${adTextTriggers.map((t) => `「${t}」`).join("、")}）`
                : "";
              throw new Error(
                `${prefix}Google Ads 以政策原因拒绝了广告素材${triggerHint}。`
                + `常见原因是标题或描述中含有商标/品牌词或其它受限表述；`
                + `请修改标题、描述后重新提交。若确为商家自有品牌，可在 Google Ads 后台对该广告点「申诉」。`,
              );
            }
          }

          // RSA 已通过 AI 改写修复（result 已置）时跳过此段，避免对同一批操作重复提交
          if (!result!) {
            // ─── D-156：只移除 index>5 的可选附加操作（关键词/扩展/图片），基础骨架 0~5 绝不可删 ───
            // 操作骨架恒为 budget0/campaign1/geo2/lang3/adGroup4/RSA广告5，靠临时资源名 -1/-2/-3 互相引用，
            // 删任何一个都会让后续操作的引用悬空（如广告引用 adGroups/-3 → RESOURCE_NOT_FOUND 自残式级联）。
            // 旧逻辑直接按 violatingIndices 删 + 仅靠 filteredOps.length>=6 护栏（只数剩余数量），
            // 当 parsePolicyViolationIndices 把级联下标解析进基础下标（如 index4 的 adGroup）时会误删骨架。
            const removableViolating = new Set([...violatingIndices].filter((i) => i > RSA_AD_INDEX));
            if (removableViolating.size === 0) {
              // 违规下标里只剩基础/级联下标 → 问题出在骨架本身，删除只会制造悬空级联，必须把真错误抛给用户。
              const readable = parsedPolicyError?.readableMessage;
              if (readable && readable.trim().length > 0) {
                throw new Error(readable);
              }
              throw mutateErr;
            }
            const filteredOps = operations.filter((_, i) => !removableViolating.has(i));
            console.log(`[AdSubmit] 移除 ${removableViolating.size} 个可选违规操作 (${skippedDetails.join(", ")}), 剩余 ${filteredOps.length} 个操作（基础骨架 0~5 已保留）`);
            result = await mutateGoogleAds(credentials, customerId, filteredOps) as Record<string, unknown>;
          }
        } else {
          throw mutateErr;
        }
      }

      // ─── 自动切换 CID 重试（Operation Not Permitted For Context） ───
      // 当前 CID 账户不支持该广告操作（如搜索广告），自动切换到其他可用 CID 后重试
      if (!result!) {
        const notPermittedViolations = (mutateErr as any)?.violations as GoogleAdsViolation[] | undefined;
        if (notPermittedViolations && isOperationNotPermittedError(notPermittedViolations)) {
          console.warn("[AdSubmit] 当前 CID 不支持该广告操作，尝试自动切换 CID...");
          const { listMccChildAccounts, checkCidAvailability } = await import("@/lib/google-ads/cid");
          const allCids = await listMccChildAccounts(credentials);
          let switchedCid = false;
          for (const alt of allCids) {
            const altCidRaw = alt.customer_id.replace(/-/g, "");
            if (altCidRaw === cid) continue;
            const available = await checkCidAvailability(credentials, alt.customer_id);
            if (!available) continue;
            // 用新 CID 替换 operations 中所有临时资源名前缀
            const newOps = JSON.parse(
              JSON.stringify(operations).replace(new RegExp(`customers/${cid}/`, "g"), `customers/${altCidRaw}/`)
            ) as Record<string, unknown>[];
            try {
              result = await mutateGoogleAds(credentials, alt.customer_id, newOps) as Record<string, unknown>;
              customerId = alt.customer_id;
              cid = altCidRaw;
              console.log(`[AdSubmit] 自动切换 CID 成功: ${alt.customer_id}`);
              switchedCid = true;
              break;
            } catch (altErr) {
              console.warn(`[AdSubmit] 备用 CID ${alt.customer_id} 同样失败:`, altErr instanceof Error ? altErr.message.slice(0, 200) : altErr);
            }
          }
          if (!switchedCid) {
            throw new Error(`所有可用 Google Ads 账户（共 ${allCids.length} 个 CID）均不支持创建搜索广告。请检查 MCC 下各账户的权限设置，或联系 Google Ads 支持后重试。`);
          }
        } else {
          throw mutateErr;
        }
      }
    }

    // D-041 兜底：理论上 catch 块所有路径都会 result=... 或 throw，但 TS 推断不出来
    if (!result!) {
      throw new Error("Google Ads 提交失败但未能识别错误类型，请刷新页面后重试或联系管理员。");
    }

    // 解析响应（API 返回 camelCase 或 snake_case 均兼容）
    const responses = (
      result.mutateOperationResponses || result.mutate_operation_responses || []
    ) as Record<string, unknown>[];

    // index 0 = budget, 1 = campaign, 2 = geo, 3 = lang, 4 = adGroup
    const campaignResp = (responses[1] || {}) as Record<string, Record<string, string>>;
    const campaignRn = String(
      campaignResp?.campaignResult?.resourceName
      || campaignResp?.campaign_result?.resource_name
      || ""
    );
    const googleCampaignId = campaignRn.split("/").pop() || "";

    if (!googleCampaignId) {
      console.error("[AdSubmit] Google Ads 响应未包含广告系列 ID，responses[1]:", JSON.stringify(responses[1] || null));
      throw new Error("Google Ads 提交返回了成功响应，但未包含广告系列 ID。这通常是 API 响应结构不匹配导致的，请刷新页面后重试，或联系管理员查看服务器日志。");
    }

    const adGroupResp = (responses[4] || {}) as Record<string, Record<string, string>>;
    const adGroupRn = String(
      adGroupResp?.adGroupResult?.resourceName
      || adGroupResp?.ad_group_result?.resource_name
      || ""
    );
    const googleAdGroupId = adGroupRn.split("/").pop() || "";

    // ─── 11. 图片素材独立提交（逐张加载+批量上传，失败不影响主广告） ───
    const MAX_IMAGES = 20;
    const MAX_TOTAL_IMAGE_BYTES = 50 * 1024 * 1024;
    const imageUploadResult = { success: 0, failed: 0, errors: [] as string[], ineligible: false };
    if (image_urls.length > 0 && campaignRn) {
      try {
        // 两阶段（修复 AD_IMAGE 直接挂载报 UNSUPPORTED_FIELD_TYPE）：
        //   阶段1 先创建图片 asset 拿真实资源名（asset 创建不受搜索广告图片素材"账户资格"限制，可复用）；
        //   阶段2 再用真实资源名挂到广告系列。避免同一原子批次里用临时负数 ID 前向引用 asset→campaign_asset。
        const assetOps: Record<string, unknown>[] = [];
        let imgTempId = -100;
        let totalBytes = 0;
        // CRAWL-04：原为「逐张 await 加载」，对图床被 CDN(Akamai)/地域封锁的商家（如 etihad）会
        //   每张 fetch 超时累计——20 张 × 15s 串行可拖到数分钟，整个提交请求被前端/nginx 当超时
        //   → 用户「发不出去」。图片上传本就非致命，故改为「并行加载 + 总预算封顶」：加载不到就跳过，
        //   绝不阻塞主广告创建。总耗时由单张超时（10s）+ 30s 总预算双重封顶。
        const urls = (image_urls as string[]).slice(0, MAX_IMAGES);
        const imgLoadDeadline = new Promise<null>((resolve) => setTimeout(() => resolve(null), 30_000));
        const loadedImgs = await Promise.all(
          urls.map((u) => Promise.race([loadImageAsBase64(u).catch(() => null), imgLoadDeadline])),
        );
        for (const img of loadedImgs) {
          if (!img) continue;
          const imgBytes = Buffer.byteLength(img.data, "base64");
          if (totalBytes + imgBytes > MAX_TOTAL_IMAGE_BYTES) break;
          totalBytes += imgBytes;
          assetOps.push({
            asset_operation: {
              create: {
                resource_name: `customers/${cid}/assets/${imgTempId}`,
                name: `AdImage-${img.name}-${Date.now()}-${Math.abs(imgTempId)}`,
                image_asset: { data: img.data },
              },
            },
          });
          imgTempId--;
        }

        if (assetOps.length > 0) {
          // ── 阶段 1：创建图片 asset ──
          const assetResult = await mutateGoogleAds(credentials, customerId, assetOps);
          const assetResponses = (
            assetResult.mutateOperationResponses || assetResult.mutate_operation_responses || []
          ) as Record<string, Record<string, string>>[];
          const assetResourceNames = assetResponses
            .map((r) => r?.assetResult?.resourceName || r?.asset_result?.resource_name || "")
            .filter(Boolean);

          // ── 阶段 2：用真实资源名挂载到广告系列（AD_IMAGE 是搜索广告图片素材的正确字段类型）──
          if (assetResourceNames.length > 0) {
            const linkOps = assetResourceNames.map((assetRn) => ({
              campaign_asset_operation: {
                create: { asset: assetRn, campaign: campaignRn, field_type: "AD_IMAGE" },
              },
            }));
            try {
              await mutateGoogleAds(credentials, customerId, linkOps);
              imageUploadResult.success = assetResourceNames.length;
              console.log(`[AdSubmit] 图片素材上传并挂载成功: ${imageUploadResult.success} 张`);
            } catch (linkErr) {
              const lmsg = linkErr instanceof Error ? linkErr.message : String(linkErr);
              // AD_IMAGE 挂载被拒最常见原因：该账户尚未满足搜索广告图片素材投放资格（需账户历史/消耗）。
              // 这是 Google 账户层面的限制而非代码缺陷——asset 已创建可复用，不影响主广告。
              const ineligible = /not supported to be added directly through asset links|UNSUPPORTED_FIELD_TYPE/i.test(lmsg);
              if (ineligible) {
                imageUploadResult.failed = assetResourceNames.length;
                imageUploadResult.ineligible = true;
                imageUploadResult.errors.push("账户暂不支持搜索广告图片素材");
                console.log(`[AdSubmit] 图片素材已创建但账户暂无资格挂载（不影响广告，需账户历史/消耗达标）: ${assetResourceNames.length} 张`);
              } else {
                throw linkErr;
              }
            }
          }
        }
      } catch (imgErr) {
        const msg = imgErr instanceof Error ? imgErr.message : String(imgErr);
        console.warn("[AdSubmit] 图片素材上传失败（不影响广告创建）:", msg.slice(0, 500));
        imageUploadResult.failed = image_urls.length;
        imageUploadResult.errors.push(msg.slice(0, 200));
      }
    }

    // ─── 更新数据库记录 ───
    await prisma.campaigns.update({
      where: { id: campaignFresh.id },
      data: {
        google_campaign_id: googleCampaignId,
        customer_id: cid,
        mcc_id: mccAccount.id,
        // 该广告归属的联盟账号 = 本次选链接/命名(CGx)所用的商家主连接。写死在广告行，
        // 后续换链/刷点击/订单归属都以此为准，不再随商家主连接漂移（wj02 CG1/CG2 串号根治点）。
        platform_connection_id: submitMerchant.platform_connection_id ?? null,
        daily_budget: daily_budget,
        bidding_strategy: bidding_strategy,
        max_cpc_limit: max_cpc_limit,
        language_id: ad_language || null,
        network_search: network_search ? 1 : 0,
        network_partners: network_partners ? 1 : 0,
        network_display: network_display ? 1 : 0,
        google_status: "ENABLED",
      },
    });

    await prisma.ad_groups.update({
      where: { id: adGroup.id },
      data: { google_ad_group_id: googleAdGroupId },
    });

    // 根治③：把本次实际提交给 Google 的关键字回写 keywords 表，让 DB 成为可信真相来源
    //   （历史上关键字多只走「SSE→内存→随提交发 Google」而未落库，导致 DB 关键字大面积为空、
    //   无法用于兜底/审计）。剔除政策重试阶段被丢弃的词（skippedKeywords）。
    let keywordPersistFailed = false;
    try {
      const persistRows = submittedKeywords
        .filter((k) => k.text.trim().length > 0 && !skippedKeywords.includes(k.text))
        .map((k) => ({
          ad_group_id: adGroup.id,
          keyword_text: k.text.trim(),
          match_type: (k.matchType || "PHRASE").toUpperCase(),
        }));
      if (persistRows.length > 0) {
        await prisma.$transaction([
          prisma.keywords.deleteMany({ where: { ad_group_id: adGroup.id } }),
          prisma.keywords.createMany({ data: persistRows, skipDuplicates: true }),
        ]);
      }
    } catch (e) {
      // D-163⑦：失败不再纯静默，成功消息里带警告，避免「提交成功但数据中心看不到关键字」的困惑
      keywordPersistFailed = true;
      console.warn("[AdSubmit] 关键字回写 DB 失败（不影响广告投放）:", e instanceof Error ? e.message : e);
    }

    await prisma.ad_creatives.update({
      where: { id: adCreative.id },
      data: {
        headlines: headlines as any,
        descriptions: descriptions as any,
        sitelinks: sitelinks.length > 0 ? sitelinks as any : undefined,
        callouts: callouts.length > 0 ? callouts as any : undefined,
        image_urls: image_urls.length > 0 ? image_urls as any : undefined,
      },
    });

    // 查询关联的文章记录
    const article = await prisma.articles.findFirst({
      where: { user_merchant_id: campaign.user_merchant_id, user_id: userId, is_deleted: 0 },
      orderBy: { id: "desc" },
      select: { id: true, status: true, slug: true, images: true },
    });

    // 将广告最终选图同步到文章 images，作为文章配图的唯一权威来源
    if (article && image_urls.length > 0) {
      await prisma.articles.update({
        where: { id: article.id },
        data: { images: image_urls as any },
      });
    }

    const msgParts: string[] = ["广告创建成功"];
    if (aiPolicyFixNotes.length > 0) {
      msgParts.push(`广告曾被 Google 拒登，系统已自动用 AI 改写 ${aiPolicyFixNotes.length} 处文案后发布成功（建议复核：${aiPolicyFixNotes.join("；")}）`);
    }
    if (skippedKeywords.length > 0) {
      msgParts.push(`已跳过 ${skippedKeywords.length} 个违反政策的关键词: ${skippedKeywords.join(", ")}`);
    }
    if (imageUploadResult.success > 0) {
      msgParts.push(`${imageUploadResult.success} 张图片素材上传成功`);
    }
    if (imageUploadResult.failed > 0) {
      msgParts.push(
        imageUploadResult.ineligible
          ? `${imageUploadResult.failed} 张图片已存入账户素材库，但该账户暂不满足搜索广告图片素材投放资格（需账户历史/消耗达标），暂未挂载到广告（不影响广告投放）`
          : `${imageUploadResult.failed} 张图片素材上传失败（不影响广告）`,
      );
    }
    if (keywordPersistFailed) {
      msgParts.push("注意：关键字已提交到 Google 但未能保存到系统数据库，数据中心可能暂时看不到关键字（不影响广告投放）");
    }
    const successMsg = msgParts.join("，");

    // 广告创建成功，立即同步商家状态（强关联）
    try {
      const { syncMerchantStatusForUser } = await import("@/lib/campaign-merchant-link");
      await syncMerchantStatusForUser(userId);
    } catch (syncErr) {
      console.error("[AdSubmit] 商家状态同步失败:", syncErr);
    }

    return apiSuccess(serializeData({
      google_campaign_id: googleCampaignId,
      customer_id: customerId,
      campaign_name: campaignNameToUse,
      article_id: article?.id || null,
      article_slug: article?.slug || null,
      article_status: article?.status || null,
      skipped_keywords: skippedKeywords,
      image_upload: imageUploadResult,
      h4_auto_fix: h4AutoFix,
    }), successMsg);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const rawBody = (err as any)?.rawBody as string | undefined;
    console.error("[AdSubmit] Google Ads 创建失败:", msg);
    if (rawBody) console.error("[AdSubmit] API 原始响应:", rawBody.slice(0, 1500));

    // 真实修复（D-085）：主 mutate 成功（广告已建于 Google）但后续持久化/同步步骤抛错时，
    // 也会落到这里。上报失败前先对账：Google 已有同名系列 → 采纳同步并如实返回成功，
    // 避免"广告已建成却报创建失败"。
    {
      const reconciled = await reconcileIfExistsInGoogle();
      if (reconciled) return reconciled;
    }

    if (msg.includes("RESOURCE_EXHAUSTED") || msg.includes("请求频率超限")) {
      return apiError("Google Ads API 请求频率超限，系统已自动重试但仍受限。请等待 3-5 分钟后再重试。（当前 Developer Token 为 explorer access 级别，频率限制较严格）");
    }

    const violations = (err as any)?.violations as GoogleAdsViolation[] | undefined;
    if (violations && violations.length > 0) {
      // OPERATION_NOT_PERMITTED 类错误：已在内层尝试换 CID 但全部失败，给出清晰指引
      if (isOperationNotPermittedError(violations)) {
        const friendlyMsg = formatGoogleAdsErrorMessage(violations);
        return apiError(`广告创建失败（账户权限不足）：\n${friendlyMsg}`, 400);
      }
      const friendlyMsg = formatGoogleAdsErrorMessage(violations);
      return apiError(`Google Ads 创建失败：\n${friendlyMsg}`, 400);
    }

    const looksLikePolicyError = msg.includes("POLICY_ERROR") || msg.includes("policyViolationError");
    if (looksLikePolicyError) {
      const parsed = parseGoogleAdsErrors(msg);
      if (parsed.length > 0) {
        return apiError(`Google Ads 创建失败：\n${formatGoogleAdsErrorMessage(parsed)}`, 400);
      }
    }

    // 检查是否为 OPERATION_NOT_PERMITTED 原始消息（violations 为空时的兜底）
    if (msg.includes("not allowed for the given context") || msg.includes("operationNotPermittedForContext")) {
      return apiError("广告创建失败：当前所有可用 CID 账户均不支持创建搜索广告，请检查 MCC 下各账户权限，或联系 Google Ads 支持开启该广告类型后重试。", 400);
    }

    return apiError(`Google Ads 创建失败：${msg.slice(0, 800)}`);
  }
}

/** 从 Google Ads API 错误消息中解析违反政策的操作索引 */
function parsePolicyViolationIndices(errMsg: string): Set<number> {
  const indices = new Set<number>();
  // Match "mutate_operations[N]" patterns in the error
  const indexPattern = /mutate_operations\[(\d+)\]/g;
  let match;
  while ((match = indexPattern.exec(errMsg)) !== null) {
    indices.add(parseInt(match[1], 10));
  }
  // Also try parsing JSON error body for fieldPathElements
  try {
    const jsonStart = errMsg.indexOf("{");
    const jsonEnd = errMsg.lastIndexOf("}");
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const jsonStr = errMsg.slice(jsonStart, jsonEnd + 1);
      const errObj = JSON.parse(jsonStr);
      const details = errObj?.error?.details || errObj?.details || [];
      for (const detail of details) {
        const errors = detail?.errors || [];
        for (const e of errors) {
          const elements = e?.location?.fieldPathElements || [];
          for (const el of elements) {
            if (el.fieldName === "mutate_operations" && el.index != null) {
              indices.add(Number(el.index));
            }
          }
        }
      }
    }
  } catch {}
  return indices;
}
