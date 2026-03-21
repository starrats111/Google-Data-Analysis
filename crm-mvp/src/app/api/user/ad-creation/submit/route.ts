import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { mutateGoogleAds, dollarsToMicros, queryGoogleAds } from "@/lib/google-ads";
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
  } = body;

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

  const credentials = {
    mcc_id: mccAccount.mcc_id,
    developer_token: mccAccount.developer_token,
    service_account_json: mccAccount.service_account_json,
  };

  let customerId = bodyCustomerId || campaign.customer_id;
  if (!customerId) {
    const { listMccChildAccounts, checkCidAvailability } = await import("@/lib/google-ads/cid");
    const cids = await listMccChildAccounts(credentials);
    for (const cid of cids) {
      const available = await checkCidAvailability(credentials, cid.customer_id);
      if (available) {
        customerId = cid.customer_id;
        break;
      }
    }
    if (!customerId) return apiError("MCC 下没有空闲的客户账号（CID）");
  }

  const cid = customerId.replace(/-/g, "");

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

  const campaignNameToUse = campaign.campaign_name || `Campaign-${Date.now()}`;

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
    // ─── 0. 先尝试清理同名冲突 ───
    try {
      await removeDuplicateCampaigns();
    } catch (cleanupErr) {
      console.warn("[AdSubmit] 首次清理同名广告出错（将在创建失败后重试）:", cleanupErr);
    }

    const operations: Record<string, unknown>[] = [];

    const budgetTempRn = `customers/${cid}/campaignBudgets/-1`;
    const campaignTempRn = `customers/${cid}/campaigns/-2`;
    const adGroupTempRn = `customers/${cid}/adGroups/-3`;

    // ─── 1. CampaignBudget（独立预算，非共享） ───
    operations.push({
      campaign_budget_operation: {
        create: {
          resource_name: budgetTempRn,
          name: `Budget-${campaign.campaign_name}-${Date.now()}`,
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
          contains_eu_political_advertising: euPoliticalValue,
        },
      },
    });

    // ─── 3. 地理定向 ───
    const countryCode = campaign.target_country?.toUpperCase() || "US";
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
          name: adGroup.ad_group_name || campaign.campaign_name || `AdGroup-${Date.now()}`,
          campaign: campaignTempRn,
          type: "SEARCH_STANDARD",
          cpc_bid_micros: String(dollarsToMicros(max_cpc_limit)),
          status: "ENABLED",
        },
      },
    });

    // ─── 6. RSA 广告 ───
    const headlineAssets = headlines.slice(0, 15).map((h: string, i: number) => ({
      text: h.slice(0, 30),
      ...(i === 0 ? { pinned_field: "HEADLINE_1" } : {}),
    }));
    const descriptionAssets = descriptions.slice(0, 4).map((d: string) => ({
      text: d.slice(0, 90),
    }));

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

    // ─── 7. 关键词 ───
    for (const kw of keywords) {
      const text = typeof kw === "string" ? kw : kw.text;
      const rawMatch = typeof kw === "string" ? "PHRASE" : (kw.matchType || "PHRASE");
      const matchType = rawMatch.toUpperCase();
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

    // ─── 8. Sitelink 扩展 ───
    let assetTempId = -10;
    for (const sl of sitelinks) {
      const assetTempRn = `customers/${cid}/assets/${assetTempId}`;
      let slUrl = (sl.finalUrl || "").trim();
      if (slUrl.startsWith("http://")) slUrl = slUrl.replace("http://", "https://");
      operations.push({
        asset_operation: {
          create: {
            resource_name: assetTempRn,
            final_urls: [slUrl],
            sitelink_asset: {
              link_text: (sl.title || "").slice(0, 25),
              description1: (sl.description1 || "").slice(0, 35),
              description2: (sl.description2 || "").slice(0, 35),
            },
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

    // ─── 9. Callout 扩展 ───
    for (const calloutText of callouts) {
      const assetTempRn = `customers/${cid}/assets/${assetTempId}`;
      operations.push({
        asset_operation: {
          create: {
            resource_name: assetTempRn,
            callout_asset: {
              callout_text: (calloutText || "").slice(0, 25),
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

    // ─── 10. 图片素材（Image Extensions） ───
    if (image_urls.length > 0) {
      const imageLoadTasks = (image_urls as string[]).slice(0, 20).map((url) => loadImageAsBase64(url));
      const imageResults = await Promise.all(imageLoadTasks);
      for (const img of imageResults) {
        if (!img) continue;
        const assetTempRn = `customers/${cid}/assets/${assetTempId}`;
        operations.push({
          asset_operation: {
            create: {
              resource_name: assetTempRn,
              name: `AdImage-${img.name}-${Date.now()}`,
              type: "IMAGE",
              image_asset: {
                data: img.data,
              },
            },
          },
        });
        operations.push({
          campaign_asset_operation: {
            create: {
              asset: assetTempRn,
              campaign: campaignTempRn,
              field_type: "MARKETING_IMAGE",
            },
          },
        });
        assetTempId--;
      }
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
          if (!retryMsg.includes("POLICY_ERROR") && !retryMsg.includes("policyViolationError")) throw retryErr;
          // Fall through to policy error handling below
          Object.assign(mutateErr as Error, { message: retryMsg });
        }
      }

      // Handle policy violations: remove violating operations and retry
      const finalMsg = mutateErr instanceof Error ? mutateErr.message : String(mutateErr);
      if (finalMsg.includes("POLICY_ERROR") || finalMsg.includes("policyViolationError")) {
        console.log("[AdSubmit] 检测到政策违规，尝试移除违规操作后重试...");
        const violatingIndices = parsePolicyViolationIndices(finalMsg);

        if (violatingIndices.size > 0) {
          // Collect skipped keyword texts for reporting
          for (const idx of violatingIndices) {
            const op = operations[idx] as any;
            const kwText = op?.ad_group_criterion_operation?.create?.keyword?.text;
            if (kwText) skippedKeywords.push(kwText);
          }

          const filteredOps = operations.filter((_, i) => !violatingIndices.has(i));
          console.log(`[AdSubmit] 移除 ${violatingIndices.size} 个违规操作 (关键词: ${skippedKeywords.join(", ")}), 剩余 ${filteredOps.length} 个操作`);

          if (filteredOps.length >= 6) {
            result = await mutateGoogleAds(credentials, customerId, filteredOps) as Record<string, unknown>;
          } else {
            throw new Error(`政策违规：关键词 [${skippedKeywords.join(", ")}] 违反 Google Ads 政策，移除后操作数不足，无法创建广告`);
          }
        } else {
          throw mutateErr;
        }
      } else if (!result!) {
        throw mutateErr;
      }
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

    const adGroupResp = (responses[4] || {}) as Record<string, Record<string, string>>;
    const adGroupRn = String(
      adGroupResp?.adGroupResult?.resourceName
      || adGroupResp?.ad_group_result?.resource_name
      || ""
    );
    const googleAdGroupId = adGroupRn.split("/").pop() || "";

    // ─── 更新数据库记录 ───
    await prisma.campaigns.update({
      where: { id: campaign.id },
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
      select: { id: true, status: true, slug: true },
    });

    const successMsg = skippedKeywords.length > 0
      ? `广告创建成功（已跳过 ${skippedKeywords.length} 个违反政策的关键词: ${skippedKeywords.join(", ")}）`
      : "广告创建成功";

    return apiSuccess(serializeData({
      google_campaign_id: googleCampaignId,
      customer_id: customerId,
      campaign_name: campaign.campaign_name,
      article_id: article?.id || null,
      article_slug: article?.slug || null,
      article_status: article?.status || null,
      skipped_keywords: skippedKeywords,
    }), successMsg);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[AdSubmit] Google Ads 创建失败:", msg);
    return apiError(`Google Ads 创建失败: ${msg.slice(0, 800)}`);
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
