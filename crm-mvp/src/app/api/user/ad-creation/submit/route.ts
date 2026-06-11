import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { getAdMarketConfig } from "@/lib/ad-market";
import { sanitizeAdText } from "@/lib/crawl-pipeline";
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
  // CRAWL-04 / 07-B：用户在「落地页无法访问」硬卡弹窗里点「我已确认可访问，仍要提交」后，
  // 前端带上 confirm_reachable=true，跳过 D-050 连接级硬卡（我们机房/代理到不了 ≠ Google 到不了）。
  const confirmReachable: boolean = body.confirm_reachable === true;

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
    const reach = await checkReachability(finalUrl, { maxRetries: 3, timeoutMs: 8000, country: campaign.target_country || "US" });
    if (isHardUnreachable(reach)) {
      // CRAWL-04 / 07-B：连接级失败（timeout/network_error/server_error）多为「本服务器出口 IP 被
      //   目标站 CDN(Akamai 等)/地域封锁」——我们到不了 ≠ 站点死了，Google 全球爬虫独立可达。
      //   故对这类失败提供「二次确认覆盖」：用户在弹窗确认落地页可正常打开后带 confirm_reachable=true，
      //   即放行提交（仍记日志留痕）。404/410 这类「服务器明确说页面没了」不在覆盖范围内（见下）。
      const fr = reach.failureReason || "";
      const isConnLevel = fr.startsWith("network_error") || fr === "timeout" || fr === "server_error";
      const overridable = isConnLevel; // 仅连接级失败可被用户确认覆盖；404/410 死链不可
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
