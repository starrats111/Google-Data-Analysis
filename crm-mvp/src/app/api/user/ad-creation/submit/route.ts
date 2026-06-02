import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { getAdMarketConfig } from "@/lib/ad-market";
import { sanitizeAdText } from "@/lib/crawl-pipeline";
import { collectAiRuleViolations, normalizeAiRuleProfile, getActivePersona, includesForbiddenTerm } from "@/lib/ai-rule-profile";
import { callAiWithFallback } from "@/lib/ai-service";
import { extractJsonFromAi } from "@/lib/crawl-pipeline";
import { isPolicyRiskKeyword } from "@/lib/keyword-optimizer";
import { mutateGoogleAds, dollarsToMicros, queryGoogleAds, parseGoogleAdsErrors, formatGoogleAdsErrorMessage, isOperationNotPermittedError } from "@/lib/google-ads";
import type { GoogleAdsViolation } from "@/lib/google-ads";
import { parsePolicyError, logPolicyViolations, type ParsedPolicyError } from "@/lib/policy-hub";
import { checkReachability, isHardUnreachable } from "@/lib/intellicenter/ad-creation";
import { assignFormalCampaignNameBeforeSubmit, resolvePlatformLabel } from "@/lib/campaign-naming";
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
      const resp = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
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
 * 提交广告到 Google Ads（REST API 批量 Mutate）
 * 单次请求创建 Budget + Campaign + AdGroup + RSA Ad + Keywords + Extensions
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const body = await req.json();
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

  if (!campaign_id) return apiError("缺少 campaign_id");
  if (!headlines?.length || headlines.length < 3) return apiError("至少需要 3 条标题");
  if (!descriptions?.length || descriptions.length < 2) return apiError("至少需要 2 条描述");

  const userId = BigInt(user.userId);

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

  const adSettings = await prisma.ad_default_settings.findFirst({
    where: { user_id: userId, is_deleted: 0 },
    select: { ai_rule_profile: true },
  });

  const adCreative = await prisma.ad_creatives.findFirst({
    where: { ad_group_id: adGroup.id, is_deleted: 0 },
  });
  if (!adCreative) return apiError("广告素材不存在");

  if (!mccAccount.service_account_json) return apiError("MCC 未配置服务账号凭证");
  if (!mccAccount.developer_token) return apiError(`MCC「${(mccAccount as { mcc_name?: string; mcc_id: string }).mcc_name || (mccAccount as { mcc_id: string }).mcc_id}」未配置 developer_token，请在「个人设置 → MCC 管理」中编辑该 MCC 填写 Developer Token`);

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
    const reach = await checkReachability(finalUrl, { maxRetries: 3, timeoutMs: 8000 });
    if (isHardUnreachable(reach)) {
      console.warn(`[AdSubmit] D-050 落地页硬卡阻断: ${finalUrl} reason=${reach.failureReason} status=${reach.statusCode}`);
      return apiError(
        `落地页无法访问（${reach.failureReason}${reach.statusCode ? `, HTTP ${reach.statusCode}` : ""}），为避免被 Google 以「目标网址无效」拒登，已阻止本次提交。请确认 ${reach.finalUrl || finalUrl} 能正常打开后再提交。`,
        422,
      );
    }
    if (!reach.reachable) {
      console.warn(`[AdSubmit] D-050 落地页可达性存疑（放行，疑似反爬/限流）: ${finalUrl} reason=${reach.failureReason} status=${reach.statusCode}`);
    }
  } catch (e) {
    // 探测本身异常（不应发生，checkReachability 内部已捕获）→ 不阻断，记录日志
    console.warn(`[AdSubmit] D-050 落地页可达性探测异常（放行）: ${e instanceof Error ? e.message : e}`);
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
              const t = String(parsed.title || "").trim().slice(0, 25);
              const d1 = String(parsed.desc1 || "").trim().slice(0, 35);
              const d2 = String(parsed.desc2 || "").trim().slice(0, 35);

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

  const aiRuleViolations = collectAiRuleViolations({
    profile: adSettings?.ai_rule_profile,
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

    const merchantRec = await prisma.user_merchants.findFirst({
      where: { id: campaign.user_merchant_id, is_deleted: 0 },
      select: { merchant_name: true },
    });
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

    const newHeadlines = await runGate(headlines as string[], "headline", 30, 2);
    const newDescriptions = await runGate(descriptions as string[], "description", 90, 40);
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

    // D-050 第2块：sitelink 提交前可达性硬卡——确定性死链的 sitelink 直接剔除（不阻断整条广告）。
    //   单条 sitelink 死链同样会被 Google 标记，影响整体审核；剔除比阻断更稳妥。
    try {
      const slArr = sitelinks as { finalUrl?: string; title?: string }[];
      const checks = await Promise.all(
        slArr.map(async (sl) => {
          const slUrl = (sl.finalUrl || "").trim();
          try {
            const r = await checkReachability(slUrl, { maxRetries: 1, timeoutMs: 6000 });
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
    developer_token: mccAccount.developer_token,
    service_account_json: mccAccount.service_account_json,
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
    select: { merchant_name: true, merchant_id: true, platform: true, platform_connection_id: true },
  });
  if (!submitMerchant) return apiError("商家不存在", 404);

  const submitAdSettings = await prisma.ad_default_settings.findFirst({
    where: { user_id: userId, is_deleted: 0 },
    select: { naming_rule: true },
  });

  const platformLabel = await resolvePlatformLabel(userId, submitMerchant.platform || "", submitMerchant.platform_connection_id);

  // ═════════════════════════════════════════════════════════════════
  // D-039 H4(C 模式) — 提交前 final gate
  //   - critical 违规（不公平优势 / 不当内容 / 电话号码 / 品牌名泄漏 / 行业禁词） → block 让员工先修
  //   - minor 违规（过度大写） → 仅记录警告，不阻断
  //   - 异常时不阻断（避免误伤正常提交）
  // ═════════════════════════════════════════════════════════════════
  try {
    const { checkAdCompliance } = await import("@/lib/ad-compliance-checker");
    const { lintRewriteAndBackfill } = await import("@/lib/intellicenter/ad-creation/compliance-linter");
    const { detectIndustryProfile } = await import("@/lib/industry-profile");
    let pageTextSnippet = "";
    try {
      if (adCreative.crawl_cache && typeof adCreative.crawl_cache === "string") {
        const parsed = JSON.parse(adCreative.crawl_cache) as { pageText?: string };
        pageTextSnippet = (parsed.pageText || "").slice(0, 2000);
      }
    } catch {}
    const industryProfile = detectIndustryProfile({
      merchantName: submitMerchant.merchant_name || "",
      category: null,
      pageText: pageTextSnippet,
    });
    const finalGate = checkAdCompliance(
      headlines as string[],
      descriptions as string[],
      { industryProfile, merchantName: submitMerchant.merchant_name || "" },
    );
    if (finalGate.criticalCount > 0) {
      // ═══ C-119：提交无障碍 —— 不再硬阻断让员工去改，智能自动修复后直接放行 ═══
      // 07 铁律：自动避障之后就不该再因"违规"挡住提交。检出 critical → AI 证据感知重写 +
      //   仍违规删除 + 静态模板补足数量，用修复后的文案继续提交（与创建阶段 C-118 同一套闭环）。
      const criticals = finalGate.violations.filter((v) => v.severity === "critical");
      const summary = criticals.slice(0, 5).map((v) => `${v.field}#${v.index}「${v.text.slice(0, 30)}」→ ${v.rule}`).join("；");
      console.warn(`[AdSubmit] H4 检出 ${finalGate.criticalCount} 条 critical，启动自动修复（不阻断提交）：${summary}`);
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
          merchantName: submitMerchant.merchant_name || "",
          industryProfile,
          industryLabel: industryProfile?.label ?? null,
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
    const finalUrlSuffix: string | undefined =
      (bodyFinalUrlSuffix ?? ((campaign as any).final_url_suffix as string | null) ?? undefined) || undefined;

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
    const headlineAssets = headlines
      .slice(0, 15)
      .map((h: string) => ({
        text: sanitizeAdText(h, { allowExclamation: true }).slice(0, 30),
      }))
      .filter((h: { text: string }, i: number, arr: { text: string }[]) =>
        h.text.length > 0 && arr.findIndex((x) => x.text.toLowerCase() === h.text.toLowerCase()) === i
      );
    const descriptionAssets = descriptions
      .slice(0, 4)
      .map((d: string) => ({
        text: sanitizeAdText(d, { allowExclamation: true }).slice(0, 90),
      }))
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
    for (const kw of keywords) {
      const text = typeof kw === "string" ? kw : kw.text;
      if (isPolicyRiskKeyword(text)) {
        console.warn(`[AdSubmit] 拦截政策风险关键词，不提交: "${text}"`);
        continue;
      }
      const rawMatch = typeof kw === "string" ? "PHRASE" : (kw.matchType || "PHRASE");
      const matchType = rawMatch.toUpperCase();
      const kwKey = `${text.toLowerCase()}|${matchType}`;
      if (seenKeywords.has(kwKey)) continue;
      seenKeywords.add(kwKey);
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

    // ─── 8. Sitelink 扩展（标题/描述需符合 Google Ads 大写和标点规范） ───
    let assetTempId = -10;
    const seenSitelinkTexts = new Set<string>();
    for (const sl of sitelinks) {
      const assetTempRn = `customers/${cid}/assets/${assetTempId}`;
      let slUrl = (sl.finalUrl || "").trim();
      if (slUrl.startsWith("http://")) slUrl = slUrl.replace("http://", "https://");
      const linkText = sanitizeAdText((sl.title || ""), { allowExclamation: false }).slice(0, 25);
      const desc1Raw = sanitizeAdText((sl.description1 || ""), { allowExclamation: true }).slice(0, 35);
      const desc2Raw = sanitizeAdText((sl.description2 || ""), { allowExclamation: true }).slice(0, 35);

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
        // desc2 为空时用 link_text 截断补全，保证二者同时存在
        sitelinkAssetPayload.description1 = desc1Raw;
        sitelinkAssetPayload.description2 = linkText.slice(0, 35);
      } else if (desc2Raw.length >= 1) {
        sitelinkAssetPayload.description1 = linkText.slice(0, 35);
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
    const validCallouts = callouts
      .map((c: string) => sanitizeAdText((c || ""), { allowExclamation: false }).slice(0, 25))
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
        promotion_target: (promotion.promotion_target || "").slice(0, 20),
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
      const seenPriceHeaders = new Set<string>();
      const priceOfferings = price.items
        .map((item: any) => {
          const header = (item.header || "").slice(0, 25);
          const headerKey = header.toLowerCase();
          if (!header || seenPriceHeaders.has(headerKey)) return null;
          seenPriceHeaders.add(headerKey);
          let description = (item.description || "").slice(0, 25);
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
    // 提交前校验电话号码是否匹配目标国家，格式不符则跳过（避免 CALL_PHONE_NUMBER_NOT_SUPPORTED_FOR_COUNTRY）
    const isPhoneValidForCountry = (phone: string, country: string): boolean => {
      const digits = phone.replace(/\D/g, "");
      const cc = (country || "US").toUpperCase();
      if (cc === "US" || cc === "CA") {
        // 北美：10位纯数字，或以1开头的11位（+1区号）
        if (digits.length === 10) return true;
        if (digits.length === 11 && digits.startsWith("1")) return true;
        return false;
      }
      if (cc === "GB" || cc === "UK") return digits.length >= 10 && digits.length <= 11;
      if (cc === "DE") return digits.length >= 10 && digits.length <= 12;
      if (cc === "FR") return digits.length === 9 || digits.length === 10;
      if (cc === "AU") return digits.length >= 9 && digits.length <= 10;
      if (cc === "JP") return digits.length >= 10 && digits.length <= 11;
      // 通用：7-15位即可
      return digits.length >= 7 && digits.length <= 15;
    };
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
    const snippetValues = (structured_snippet?.values || [])
      .slice(0, 10)
      .map((v: string) => (v || "").slice(0, 25))
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
    const validNegativeKws: string[] = Array.isArray(negative_keywords)
      ? negative_keywords
          .map((k: string) => String(k || "").trim().toLowerCase())
          .filter((k: string) => k.length >= 2 && k.length <= 80)
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
    try {
      result = await mutateGoogleAds(credentials, customerId, operations) as Record<string, unknown>;
    } catch (mutateErr) {
      const errMsg = mutateErr instanceof Error ? mutateErr.message : String(mutateErr);

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
            // D-041：优先用 policy-hub 深度解析的 readableMessage（含「标题3 触发 TRADEMARK_VIOLATION」位置 + 政策原文 URL + 修复建议）
            const readable = parsedPolicyError?.readableMessage;
            if (readable && readable.trim().length > 0) {
              throw new Error(readable);
            }
            // 兜底（policy-hub 解析失败时仍走旧路径，但已过滤 -2/-3）
            const triggerList = errViolations
              ?.filter((v) => v.trigger && !/^-?\d+$/.test(v.trigger.trim()))
              .map((v) => `「${v.trigger}」`) || [];
            const triggerHint = triggerList.length > 0 ? `（违规内容: ${triggerList.join(", ")}）` : "";
            throw new Error(`Google Ads 拒绝了 RSA 广告素材${triggerHint}，请修改标题或描述中的违规文案后重新提交。（违规操作: ${skippedDetails.join("、")}）`);
          }

          const filteredOps = operations.filter((_, i) => !violatingIndices.has(i));
          console.log(`[AdSubmit] 移除 ${violatingIndices.size} 个违规操作 (${skippedDetails.join(", ")}), 剩余 ${filteredOps.length} 个操作`);

          if (filteredOps.length >= 6) {
            result = await mutateGoogleAds(credentials, customerId, filteredOps) as Record<string, unknown>;
          } else {
            // D-041：同样优先用 policy-hub readableMessage
            const readable = parsedPolicyError?.readableMessage;
            if (readable && readable.trim().length > 0) {
              throw new Error(`Google Ads 因政策违规拒绝了 ${violatingIndices.size} 个操作，移除后剩余操作不足。\n\n${readable}`);
            }
            const triggerList = errViolations
              ?.filter((v) => v.trigger && !/^-?\d+$/.test(v.trigger.trim()))
              .map((v) => `「${v.trigger}」`) || [];
            const triggerHint = triggerList.length > 0 ? `（触发违规的内容: ${triggerList.join(", ")}）` : "";
            throw new Error(`Google Ads 因政策违规拒绝了 ${violatingIndices.size} 个操作（${skippedDetails.join("、")}），移除后剩余操作不足，无法创建广告。${triggerHint}请修改相关关键词或广告文案后重新提交。`);
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
        for (const url of (image_urls as string[]).slice(0, MAX_IMAGES)) {
          const img = await loadImageAsBase64(url);
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
    }), successMsg);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const rawBody = (err as any)?.rawBody as string | undefined;
    console.error("[AdSubmit] Google Ads 创建失败:", msg);
    if (rawBody) console.error("[AdSubmit] API 原始响应:", rawBody.slice(0, 1500));

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
