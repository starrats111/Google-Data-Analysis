import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError, normalizePlatformCode } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { generateCampaignName } from "@/lib/campaign-naming";
import { buildKeywordCreateManyInput, selectOptimizedKeywords } from "@/lib/ad-keyword-pipeline";

// 国家 → Google Ads 语言代码（创建 campaign 时自动设置）
const COUNTRY_TO_LANG_CODE: Record<string, string> = {
  US: "en", UK: "en", GB: "en", CA: "en", AU: "en", IE: "en", SG: "en", NZ: "en", PH: "en", IN: "en",
  DE: "de", AT: "de", CH: "de",
  FR: "fr", BE: "fr",
  ES: "es", MX: "es", AR: "es", CL: "es", CO: "es",
  IT: "it", PT: "pt", BR: "pt", NL: "nl",
  JP: "ja", KR: "ko", CN: "zh_CN", TW: "zh_TW", HK: "zh_TW",
  RU: "ru", PL: "pl", SE: "sv", NO: "no", DK: "da", FI: "fi", CZ: "cs",
  TR: "tr", TH: "th", VN: "vi", ID: "id", MY: "ms",
  SA: "ar", AE: "ar", IL: "iw", GR: "el", RO: "ro", HU: "hu", BG: "bg",
};

// 政策类别代码 → 中文
const POLICY_CATEGORY_CN: Record<string, string> = {
  alcohol: "酒类", gambling: "赌博", tobacco: "烟草", cannabis: "大麻/CBD",
  adult: "成人内容", weapons: "武器", pharma: "处方药", financial: "金融服务",
  healthcare: "医疗保健", political: "政治广告", crypto: "加密货币",
  weight_loss: "减肥产品", dating: "交友", legal: "法律服务",
  supplements: "保健品", cbd: "CBD 产品", vaping: "电子烟",
  fireworks: "烟花爆竹", counterfeit: "仿冒品", hacking: "黑客工具",
  surveillance: "监控设备", bail_bonds: "保释金", payday_loans: "发薪日贷款",
};

/**
 * 批量匹配推荐/违规/政策标签
 * 用 merchant_name 做模糊匹配（大小写不敏感）
 */
async function enrichWithLabels(merchants: any[]) {
  if (merchants.length === 0) return merchants;

  const names = merchants.map(m => m.merchant_name?.toLowerCase()).filter(Boolean);
  if (names.length === 0) return merchants;

  // 一次性查出所有推荐和违规记录
  const [recs, vios] = await Promise.all([
    prisma.merchant_recommendations.findMany({
      where: { is_deleted: 0 },
      select: { merchant_name: true, roi_reference: true, commission_info: true, settlement_info: true, remark: true },
    }),
    prisma.merchant_violations.findMany({
      where: { is_deleted: 0 },
      select: { merchant_name: true, violation_reason: true, source: true, violation_time: true },
    }),
  ]);

  // 构建 name → detail 映射（小写匹配）
  const recMap = new Map<string, { roi: string; commission: string; settlement: string; remark: string }>();
  for (const r of recs) {
    recMap.set(r.merchant_name.toLowerCase(), {
      roi: r.roi_reference || "",
      commission: r.commission_info || "",
      settlement: r.settlement_info || "",
      remark: r.remark || "",
    });
  }
  // 违规匹配支持：精确名称 + 去掉国家代码后的基础名称
  const vioMap = new Map<string, { reason: string; source: string; time: Date | null }>();
  const vioBaseMap = new Map<string, { reason: string; source: string; time: Date | null }>();

  const COUNTRY_CODES = new Set([
    "US", "UK", "GB", "DE", "FR", "IT", "ES", "NL", "BE", "AT", "CH", "AU", "CA",
    "JP", "KR", "CN", "HK", "TW", "SG", "MY", "TH", "PH", "ID", "VN", "IN",
    "BR", "MX", "AR", "CL", "CO", "PE", "SE", "NO", "DK", "FI", "PL", "CZ",
    "PT", "IE", "NZ", "ZA", "AE", "SA", "IL", "RU", "TR", "GR", "RO", "HU",
  ]);
  const stripSuffix = (name: string) => {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2 && COUNTRY_CODES.has(parts[parts.length - 1].toUpperCase()) && parts[parts.length - 1].length === 2) {
      return parts.slice(0, -1).join(" ").toLowerCase();
    }
    return name.toLowerCase();
  };

  for (const v of vios) {
    const detail = { reason: v.violation_reason || "", source: v.source || "", time: v.violation_time };
    const fullName = v.merchant_name.toLowerCase();
    vioMap.set(fullName, detail);
    const baseName = stripSuffix(v.merchant_name);
    if (baseName !== fullName) vioBaseMap.set(baseName, detail);
    // 也存基础名
    vioBaseMap.set(baseName, detail);
  }

  return merchants.map(m => {
    const fullKey = m.merchant_name?.toLowerCase() || "";
    const baseKey = stripSuffix(m.merchant_name || "");
    const rec = recMap.get(fullKey);
    // 先精确匹配，再基础名匹配
    const vio = vioMap.get(fullKey) || vioBaseMap.get(baseKey) || vioBaseMap.get(fullKey);
    const policyStatus = m.policy_status || "pending";

    // 构建标签数组
    const labels: { type: string; color: string; text: string; detail: string }[] = [];
    if (rec) {
      const parts = [];
      if (rec.roi) parts.push(`参考 ROI: ${rec.roi}`);
      if (rec.commission) parts.push(`佣金: ${rec.commission}`);
      if (rec.settlement) parts.push(`结算: ${rec.settlement}`);
      if (rec.remark) parts.push(rec.remark);
      labels.push({ type: "recommended", color: "green", text: "推荐", detail: parts.join("；") || "管理员推荐商家" });
    }
    if (vio) {
      const parts = [];
      if (vio.reason) parts.push(vio.reason);
      if (vio.source) parts.push(`来源: ${vio.source}`);
      labels.push({ type: "violation", color: "red", text: "违规", detail: parts.join("；") || "存在违规记录" });
    }
    if (policyStatus === "restricted") {
      const catCn = POLICY_CATEGORY_CN[m.policy_category_code || ""] || m.policy_category_code || "未知";
      labels.push({ type: "restricted", color: "orange", text: "限制", detail: `政策类别: ${catCn}，投放受限` });
    } else if (policyStatus === "prohibited") {
      const catCn = POLICY_CATEGORY_CN[m.policy_category_code || ""] || m.policy_category_code || "未知";
      labels.push({ type: "prohibited", color: "red", text: "禁止", detail: `政策类别: ${catCn}，禁止投放` });
    }

    return { ...m, labels, is_recommended: !!rec };
  });
}

/**
 * 批量计算在投人数：对一批商家 (merchant_id + platform)，
 * 统计有多少个用户有 ENABLED 的 campaigns
 */
async function batchActiveAdvertisers(merchants: { merchant_id: string; platform: string }[]) {
  if (merchants.length === 0) return new Map<string, number>();

  const keys = [...new Set(merchants.map(m => `${m.platform}:${m.merchant_id}`))];
  const mids = [...new Set(merchants.map(m => m.merchant_id))];
  const platforms = [...new Set(merchants.map(m => m.platform))];

  // 找所有用户中 claimed 的相同 merchant_id + platform
  const allClaimed = await prisma.user_merchants.findMany({
    where: { merchant_id: { in: mids }, platform: { in: platforms }, status: "claimed", is_deleted: 0 },
    select: { id: true, user_id: true, merchant_id: true, platform: true },
  });

  if (allClaimed.length === 0) return new Map<string, number>();

  const umIds = allClaimed.map(um => um.id);

  // 查启用的 campaigns
  const campaigns = await prisma.campaigns.findMany({
    where: { user_merchant_id: { in: umIds }, is_deleted: 0, google_status: "ENABLED" },
    select: { user_id: true, user_merchant_id: true },
  });

  // user_merchant_id → user_ids
  const umUserMap = new Map<string, Set<string>>();
  for (const c of campaigns) {
    const key = c.user_merchant_id.toString();
    if (!umUserMap.has(key)) umUserMap.set(key, new Set());
    umUserMap.get(key)!.add(c.user_id.toString());
  }

  // merchant_id:platform → unique user count
  const result = new Map<string, number>();
  for (const um of allClaimed) {
    const k = `${um.platform}:${um.merchant_id}`;
    const users = umUserMap.get(um.id.toString());
    if (users) {
      const existing = result.get(k) || 0;
      // 需要去重 — 合并 user_id 集合
      if (!result.has(k)) {
        result.set(k, users.size);
      } else {
        // 简单追加（同一个用户可能有多个 user_merchants 条目但概率低）
        result.set(k, existing + users.size);
      }
    }
  }

  return result;
}

/**
 * GET /api/user/merchants
 *
 * tab=claimed  → "我的商家"：从 campaigns 表提取 MID，关联 user_merchants，附带广告系列状态
 * tab=available → "选取商家"：user_merchants 中排除"我的商家"已有的 MID
 */
export const GET = withUser(async (req: NextRequest, { user }) => {
  const { searchParams } = new URL(req.url);
  const tab = searchParams.get("tab") || "claimed";
  const platform = searchParams.get("platform") || "";
  const search = searchParams.get("search") || "";
  const page = parseInt(searchParams.get("page") || "1");
  const pageSize = Math.min(parseInt(searchParams.get("pageSize") || "50"), 200);

  const label = searchParams.get("label") || "";
  const sortField = searchParams.get("sortField") || "";
  const sortOrder = (searchParams.get("sortOrder") || "asc") as "asc" | "desc";
  const userId = BigInt(user.userId);

  // 构建服务端排序
  const SORTABLE_FIELDS = new Set(["merchant_name", "commission_rate", "platform", "merchant_id", "category", "updated_at"]);
  function buildOrderBy(defaultOrder: Record<string, string>[]) {
    if (sortField && SORTABLE_FIELDS.has(sortField)) {
      return [{ [sortField]: sortOrder }];
    }
    return defaultOrder;
  }

  if (tab === "claimed") {
    // ─── 数据一致性修复：有 campaigns 但无 claimed 商家时，自动关联 + 认领 ───
    const [consistCampaignCount, consistClaimedCount] = await Promise.all([
      prisma.campaigns.count({ where: { user_id: userId, is_deleted: 0, google_campaign_id: { not: null } } }),
      prisma.user_merchants.count({ where: { user_id: userId, is_deleted: 0, status: "claimed" } }),
    ]);

    if (consistCampaignCount > 0 && consistClaimedCount === 0) {
      try {
        await autoLinkAndClaimMerchants(userId);
      } catch (err) {
        console.error("[Merchants] 自动关联认领失败:", err);
      }
    }

    // ─── 我的商家：直接查 status="claimed" 的商家，不依赖广告系列 ───
    const where: Record<string, unknown> = {
      user_id: userId,
      is_deleted: 0,
      status: "claimed",
    };
    if (platform) where.platform = platform;
    if (search) {
      where.OR = [
        { merchant_name: { contains: search } },
        { merchant_id: { contains: search } },
      ];
    }

    const claimedOrderBy = buildOrderBy([
      { recommendation_status: "desc" },
      { updated_at: "desc" },
    ]);
    const [total, merchants] = await Promise.all([
      prisma.user_merchants.count({ where: where as never }),
      prisma.user_merchants.findMany({
        where: where as never,
        orderBy: claimedOrderBy as never,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    // 通过 user_merchant_id 查关联的广告系列（而非从 campaign_name 解析 MID）
    const merchantIds = merchants.map((m: any) => m.id);
    const campaigns = merchantIds.length > 0
      ? await prisma.campaigns.findMany({
          where: { user_id: userId, is_deleted: 0, user_merchant_id: { in: merchantIds } },
          select: { user_merchant_id: true, google_status: true, google_campaign_id: true, campaign_name: true },
        })
      : [];

    const campaignMap = new Map<string, { status: string | null; campaignName: string | null; campaignId: string | null }>();
    for (const c of campaigns) {
      const key = c.user_merchant_id.toString();
      const existing = campaignMap.get(key);
      if (!existing || (c.google_status === "ENABLED" && existing.status !== "ENABLED")) {
        campaignMap.set(key, {
          status: c.google_status,
          campaignName: c.campaign_name,
          campaignId: c.google_campaign_id,
        });
      }
    }

    const withLabels = await enrichWithLabels(merchants);
    const advMap = await batchActiveAdvertisers(merchants.map((m: any) => ({ merchant_id: m.merchant_id, platform: m.platform })));
    const enriched = withLabels.map((m) => {
      const info = campaignMap.get(m.id.toString());
      let adStatus = "NOT_SUBMITTED";
      if (info?.campaignId) {
        adStatus = info.status || "UNKNOWN";
      }
      return {
        ...m,
        ad_status: adStatus,
        ad_campaign_name: info?.campaignName || null,
        ad_campaign_id: info?.campaignId || null,
        active_advertisers: advMap.get(`${m.platform}:${m.merchant_id}`) || 0,
      };
    });

    // 默认排序时，优先显示已启用（ENABLED）的商家
    if (!sortField) {
      const STATUS_PRIORITY: Record<string, number> = { ENABLED: 0, PAUSED: 1, NOT_SUBMITTED: 2, UNKNOWN: 3 };
      enriched.sort((a, b) => (STATUS_PRIORITY[a.ad_status] ?? 9) - (STATUS_PRIORITY[b.ad_status] ?? 9));
    }

    const platformStats = await prisma.user_merchants.groupBy({
      by: ["platform"],
      where: { user_id: userId, is_deleted: 0, status: "claimed" } as never,
      _count: true,
    });

    return apiSuccess(serializeData({
      merchants: enriched,
      total,
      page,
      pageSize,
      stats: {
        total,
        claimed: total,
        byPlatform: platformStats,
      },
    }));

  } else {
    // ─── 选取商家：仅查询 status="available" 的商家 ───
    const where: Record<string, unknown> = {
      user_id: userId,
      is_deleted: 0,
      status: "available",
    };
    if (platform) where.platform = platform;
    if (search) {
      where.OR = [
        { merchant_name: { contains: search } },
        { merchant_id: { contains: search } },
      ];
    }

    // 标签筛选：在数据库层面预筛选
    if (label === "recommended") {
      const recNames = (await prisma.merchant_recommendations.findMany({
        where: { is_deleted: 0 }, select: { merchant_name: true },
      })).map(r => r.merchant_name);
      if (recNames.length > 0) {
        where.merchant_name = { in: recNames };
      } else {
        return apiSuccess(serializeData({ merchants: [], total: 0, page, pageSize, stats: { total: 0, claimed: 0, byPlatform: [] } }));
      }
    } else if (label === "violation") {
      const vioNames = (await prisma.merchant_violations.findMany({
        where: { is_deleted: 0 }, select: { merchant_name: true },
      })).map(v => v.merchant_name);
      if (vioNames.length > 0) {
        where.merchant_name = { in: vioNames };
      } else {
        return apiSuccess(serializeData({ merchants: [], total: 0, page, pageSize, stats: { total: 0, claimed: 0, byPlatform: [] } }));
      }
    } else if (label === "restricted") {
      where.policy_status = "restricted";
    } else if (label === "prohibited") {
      where.policy_status = "prohibited";
    }

    const availOrderBy = buildOrderBy([
      { platform: "asc" },
      { merchant_name: "asc" },
    ]);
    const [total, merchants] = await Promise.all([
      prisma.user_merchants.count({ where: where as never }),
      prisma.user_merchants.findMany({
        where: where as never,
        orderBy: availOrderBy as never,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    // 附加推荐/违规标签 + 在投人数
    const withLabels = await enrichWithLabels(merchants);
    const advMap = await batchActiveAdvertisers(merchants.map((m: any) => ({ merchant_id: m.merchant_id, platform: m.platform })));
    for (const m of withLabels) {
      m.active_advertisers = advMap.get(`${m.platform}:${m.merchant_id}`) || 0;
    }
    // 仅在无用户指定排序时，推荐商家优先
    if (!sortField) {
      withLabels.sort((a, b) => {
        if (a.is_recommended && !b.is_recommended) return -1;
        if (!a.is_recommended && b.is_recommended) return 1;
        return 0;
      });
    }

    // 统计（全量，不分 tab）
    const [platformStats, totalAll, claimedCount] = await Promise.all([
      prisma.user_merchants.groupBy({
        by: ["platform"],
        where: { user_id: userId, is_deleted: 0 },
        _count: true,
      }),
      prisma.user_merchants.count({ where: { user_id: userId, is_deleted: 0 } }),
      prisma.user_merchants.count({ where: { user_id: userId, is_deleted: 0, status: "claimed" } }),
    ]);

    return apiSuccess(serializeData({
      merchants: withLabels,
      total,
      page,
      pageSize,
      stats: { total: totalAll, claimed: claimedCount, byPlatform: platformStats },
    }));
  }
});

// 领取商家
export const POST = withUser(async (req: NextRequest, { user }) => {
  const { merchant_id, target_country, holiday_name, platform_connection_id, mcc_account_id } = await req.json();
  if (!merchant_id) return apiError("缺少商家 ID");
  if (!target_country) return apiError("请选择目标国家");
  if (target_country.length > 8) return apiError("国家代码格式无效");

  const merchant = await prisma.user_merchants.findFirst({
    where: { id: BigInt(merchant_id), user_id: BigInt(user.userId), is_deleted: 0 },
  });

  if (!merchant) return apiError("商家不存在");

  // ─── 政策审核检查 ───
  if (merchant.policy_status === "prohibited") {
    return apiError(`该商家属于 Google Ads 禁止投放类别（${merchant.policy_category_code || "受限"}），无法领取`);
  }

  // 如果是 restricted 类商家，获取政策规则用于 final_url 参数
  let policyCategory: any = null;
  if (merchant.policy_status === "restricted" && merchant.policy_category_code) {
    policyCategory = await prisma.ad_policy_categories.findFirst({
      where: { category_code: merchant.policy_category_code, is_deleted: 0 },
    });
  }

  // 如果未指定 platform_connection_id，自动选择该平台的第一个连接
  let connId = platform_connection_id ? BigInt(platform_connection_id) : null;
  let connAccountName = "";
  if (connId) {
    const conn = await prisma.platform_connections.findFirst({
      where: { id: connId, user_id: BigInt(user.userId), is_deleted: 0 },
      select: { id: true, account_name: true },
    });
    connAccountName = conn?.account_name || "";
  }
  if (!connId && merchant.platform) {
    const defaultConn = await prisma.platform_connections.findFirst({
      where: { user_id: BigInt(user.userId), platform: merchant.platform, is_deleted: 0 },
      select: { id: true, account_name: true },
      orderBy: { created_at: "asc" },
    });
    if (defaultConn) {
      connId = defaultConn.id;
      connAccountName = defaultConn.account_name || "";
    }
  }

  // 更新商家状态
  await prisma.user_merchants.update({
    where: { id: BigInt(merchant_id) },
    data: {
      status: "claimed",
      claimed_at: new Date(),
      target_country,
      holiday_name: holiday_name || null,
      platform_connection_id: connId,
    },
  });

  // 读取广告默认设置
  const adSettings = await prisma.ad_default_settings.findFirst({
    where: { user_id: BigInt(user.userId), is_deleted: 0 },
  });

  // 确定 MCC：前端传入 > 用户最近使用的 MCC
  let claimMccId: bigint | null = null;
  if (mcc_account_id) {
    claimMccId = BigInt(mcc_account_id);
  } else {
    const recentMcc = await prisma.campaigns.findFirst({
      where: { user_id: BigInt(user.userId), mcc_id: { not: null }, is_deleted: 0 },
      orderBy: { updated_at: "desc" },
      select: { mcc_id: true },
    });
    claimMccId = recentMcc?.mcc_id ?? null;
  }

  // 生成广告系列名称（按 MCC 分开计算序号）
  const campaignName = await generateCampaignName(
    BigInt(user.userId),
    merchant.platform || "",
    merchant.merchant_name || "",
    target_country,
    merchant.merchant_id || "",
    adSettings?.naming_rule || "global",
    connAccountName,
    adSettings?.naming_prefix || "",
    claimMccId,
  );

  // 根据目标国家自动确定广告语言
  const langCode = COUNTRY_TO_LANG_CODE[target_country.toUpperCase()] || "en";

  // 创建广告系列
  const campaign = await prisma.campaigns.create({
    data: {
      user_id: BigInt(user.userId),
      user_merchant_id: BigInt(merchant_id),
      campaign_name: campaignName,
      daily_budget: adSettings?.daily_budget || 2.0,
      bidding_strategy: adSettings?.bidding_strategy || "MAXIMIZE_CLICKS",
      max_cpc_limit: adSettings?.max_cpc || 0.3,
      target_country,
      language_id: langCode,
      network_search: adSettings?.network_search ?? 1,
      network_partners: adSettings?.network_partners ?? 0,
      network_display: adSettings?.network_display ?? 0,
    },
  });

  // 创建广告组
  const adGroup = await prisma.ad_groups.create({
    data: {
      campaign_id: campaign.id,
      ad_group_name: `${merchant.merchant_name} - AdGroup`,
    },
  });

  // 创建空的广告素材（后续由异步任务填充 headlines/descriptions）
  let finalUrl = merchant.merchant_url || merchant.tracking_link || "";
  if (finalUrl.startsWith("http://")) {
    finalUrl = finalUrl.replace("http://", "https://");
  }
  if (policyCategory && finalUrl) {
    const lpRules = policyCategory.landing_page_rules as Record<string, any> | null;
    if (lpRules?.url_params) {
      const separator = finalUrl.includes("?") ? "&" : "?";
      const params = new URLSearchParams(lpRules.url_params).toString();
      finalUrl = `${finalUrl}${separator}${params}`;
    }
  }

  const adCreative = await prisma.ad_creatives.create({
    data: {
      ad_group_id: adGroup.id,
      final_url: finalUrl,
      headlines: [],
      descriptions: [],
    },
  });

  // 自动推导发布站点
  let publishSiteId: bigint | null = null;
  try {
    const platformConn = await prisma.platform_connections.findFirst({
      where: {
        user_id: BigInt(user.userId),
        platform: merchant.platform,
        is_deleted: 0,
        publish_site_id: { not: null },
      },
    });
    if (platformConn?.publish_site_id) {
      publishSiteId = platformConn.publish_site_id;
    }
    // 如果没有平台绑定站点，取第一个可用站点
    if (!publishSiteId) {
      const firstSite = await prisma.publish_sites.findFirst({
        where: { is_deleted: 0, status: "active", verified: 1 },
        select: { id: true },
      });
      if (firstSite) publishSiteId = firstSite.id;
    }
  } catch { /* ignore */ }

  // 追踪链接优先使用 campaign_link（联盟平台推广链接）
  const articleTrackingLink = merchant.campaign_link || merchant.tracking_link || "";

  // 异步创建文章生成任务（领取商家时自动触发）
  const initTitle = `${merchant.merchant_name} Review`;
  const initSlug = initTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const article = await prisma.articles.create({
    data: {
      user_id: BigInt(user.userId),
      user_merchant_id: BigInt(merchant_id),
      publish_site_id: publishSiteId,
      language: "en",
      title: initTitle,
      slug: initSlug,
      status: "generating",
      merchant_name: merchant.merchant_name,
      tracking_link: articleTrackingLink || null,
    },
  });

  // ─── 异步任务 A：SemRush 竞品数据获取 + AI 补充 ───
  triggerAdCopyGeneration(
    adCreative.id,
    adGroup.id,
    merchant.merchant_name,
    merchant.merchant_url || "",
    target_country,
    {
      dailyBudget: Number(adSettings?.daily_budget || 2.0),
      maxCpc: Number(adSettings?.max_cpc || 0.3),
      biddingStrategy: adSettings?.bidding_strategy || "MAXIMIZE_CLICKS",
      aiRuleProfile: (adSettings as any)?.ai_rule_profile,
    },
  ).catch((err) => console.error("[异步] 广告文案生成失败:", err));

  // ─── 异步任务 B：爬取商家网站 + 文章生成（CRM 自有 AI） ───
  triggerArticleGeneration(
    BigInt(user.userId),
    BigInt(merchant_id),
    article.id,
    adCreative.id,
    merchant.merchant_name,
    merchant.merchant_url || "",
    target_country,
    articleTrackingLink,
  ).catch((err) => console.error("[异步] 文章生成失败:", err));

  return apiSuccess(serializeData({
    merchant_id: merchant.id,
    campaign_id: campaign.id,
    ad_group_id: adGroup.id,
    article_id: article.id,
    policy_status: merchant.policy_status,
    policy_category_code: merchant.policy_category_code,
  }), "领取成功");
});

// 批量操作（如批量释放）
export const PUT = withUser(async (req: NextRequest, { user }) => {
  const { action, ids } = await req.json();
  if (!action || !ids?.length) return apiError("缺少操作参数");
  if (ids.length > 100) return apiError("单次操作不能超过 100 条");

  if (action === "release") {
    const merchantIds = ids.map((id: string) => BigInt(id));
    const userId = BigInt(user.userId);

    // 获取这些 user_merchants 的 merchant_id（用于按 campaign_name 匹配同步来的广告系列）
    const userMerchants = await prisma.user_merchants.findMany({
      where: { id: { in: merchantIds }, user_id: userId },
      select: { id: true, merchant_id: true },
    });
    const mids = userMerchants.map(m => m.merchant_id).filter(Boolean);

    // 查找关联的 campaigns：通过 user_merchant_id 或 campaign_name 末尾的 MID
    const allUserCampaigns = await prisma.campaigns.findMany({
      where: { user_id: userId, is_deleted: 0 },
      select: { id: true, user_merchant_id: true, campaign_name: true },
    });

    const campaignIds: bigint[] = [];
    for (const c of allUserCampaigns) {
      // 方式1: 通过 user_merchant_id 匹配
      if (merchantIds.some((mid: bigint) => mid === c.user_merchant_id)) {
        campaignIds.push(c.id);
        continue;
      }
      // 方式2: 通过 campaign_name 末尾的 MID 匹配（同步来的广告系列 user_merchant_id=0）
      if (c.campaign_name && mids.length > 0) {
        const parts = c.campaign_name.split(/[-\s]+/);
        const nameMid = parts[parts.length - 1]?.trim();
        if (nameMid && mids.includes(nameMid)) {
          campaignIds.push(c.id);
        }
      }
    }

    if (campaignIds.length > 0) {
      const adGroups = await prisma.ad_groups.findMany({
        where: { campaign_id: { in: campaignIds }, is_deleted: 0 },
        select: { id: true },
      });
      const adGroupIds = adGroups.map(g => g.id);

      if (adGroupIds.length > 0) {
        await prisma.keywords.updateMany({
          where: { ad_group_id: { in: adGroupIds }, is_deleted: 0 },
          data: { is_deleted: 1 },
        });
        await prisma.ad_creatives.updateMany({
          where: { ad_group_id: { in: adGroupIds }, is_deleted: 0 },
          data: { is_deleted: 1 },
        });
        await prisma.ad_groups.updateMany({
          where: { id: { in: adGroupIds } },
          data: { is_deleted: 1 },
        });
      }

      await prisma.ads_daily_stats.deleteMany({
        where: { campaign_id: { in: campaignIds } },
      });

      await prisma.campaigns.updateMany({
        where: { id: { in: campaignIds } },
        data: { is_deleted: 1 },
      });
    }

    // 软删除关联的 articles
    await prisma.articles.updateMany({
      where: { user_merchant_id: { in: merchantIds }, user_id: userId, is_deleted: 0 },
      data: { is_deleted: 1 },
    });

    // 重置商家状态
    await prisma.user_merchants.updateMany({
      where: { id: { in: merchantIds }, user_id: userId },
      data: { status: "available", claimed_at: null, target_country: null, holiday_name: null },
    });
    return apiSuccess(null, "释放成功");
  }

  return apiError("未知操作");
});

// 全局生成锁：防止同一 adCreative 被多个流程同时生成
const adCopyGeneratingSet = new Set<string>();

/**
 * 异步触发广告文案生成（SemRush 竞品数据 + AI 补充）
 * 标题和描述并行生成，各自完成后立即保存，大幅缩短总耗时
 */
async function triggerAdCopyGeneration(
  adCreativeId: bigint,
  adGroupId: bigint,
  merchantName: string,
  merchantUrl: string,
  country: string,
  options: {
    dailyBudget?: number;
    maxCpc?: number;
    biddingStrategy?: string;
    aiRuleProfile?: unknown;
  } = {},
) {
  const lockKey = `adcopy-${adCreativeId}`;
  if (adCopyGeneratingSet.has(lockKey)) {
    console.log(`[AdCopy] 跳过：${lockKey} 正在生成中`);
    return;
  }
  adCopyGeneratingSet.add(lockKey);
  try {
    const { SemRushClient } = await import("@/lib/semrush-client");
    const { padHeadlines, padDescriptions, suggestDisplayPaths } = await import("@/lib/ai-service");

    let dedupedTitles: string[] = [];
    let dedupedDescriptions: string[] = [];
    let keywords: Array<{ phrase: string; volume: number; competition?: string | number | null; suggested_bid?: number | null; cpc?: number | null }> = [];

    if (merchantUrl) {
      try {
        const client = await SemRushClient.fromConfig(country);
        const result = await client.queryDomain(merchantUrl);
        dedupedTitles = result.dedupedTitles;
        dedupedDescriptions = result.dedupedDescriptions;
        keywords = result.keywords;
        console.log(`[AdCopy] SemRush 获取成功: ${dedupedTitles.length} 标题, ${dedupedDescriptions.length} 描述, ${keywords.length} 关键词`);
      } catch (err) {
        console.warn("[AdCopy] SemRush 获取失败，将完全由 AI 生成:", err);
      }
    }

    const optimizedKeywords = selectOptimizedKeywords(keywords, {
      merchantName,
      dailyBudget: options.dailyBudget,
      maxCpc: options.maxCpc,
      biddingStrategy: options.biddingStrategy,
      aiRuleProfile: options.aiRuleProfile,
      limit: 12,
    });

    const commonOpts = {
      keywords: optimizedKeywords.map((kw) => kw.phrase),
      dailyBudget: options.dailyBudget,
      maxCpc: options.maxCpc,
      biddingStrategy: options.biddingStrategy,
      aiRuleProfile: options.aiRuleProfile,
    };

    // 并行生成标题和描述，各自完成后立即保存到 DB
    const headlinesTask = padHeadlines([], merchantName, country, 15, {
      ...commonOpts,
      referenceItems: dedupedTitles,
    }).then(async (headlines) => {
      const existingCreative = await prisma.ad_creatives.findUnique({
        where: { id: adCreativeId },
        select: { display_path1: true, display_path2: true },
      });
      const pathSuggest = suggestDisplayPaths(merchantName, optimizedKeywords.map((kw) => kw.phrase), country);
      await prisma.ad_creatives.update({
        where: { id: adCreativeId },
        data: {
          headlines: headlines as any,
          ...(!existingCreative?.display_path1?.trim() ? { display_path1: pathSuggest.path1 } : {}),
          ...(!existingCreative?.display_path2?.trim() ? { display_path2: pathSuggest.path2 } : {}),
        },
      });
      console.log(`[AdCopy] 标题已保存 (${headlines.length} 条)`);
      return headlines;
    });

    const descriptionsTask = padDescriptions([], merchantName, country, 4, {
      ...commonOpts,
      referenceItems: dedupedDescriptions,
    }).then(async (descriptions) => {
      await prisma.ad_creatives.update({
        where: { id: adCreativeId },
        data: { descriptions: descriptions as any },
      });
      console.log(`[AdCopy] 描述已保存 (${descriptions.length} 条)`);
      return descriptions;
    });

    const keywordsTask = optimizedKeywords.length > 0
      ? prisma.keywords.createMany({ data: buildKeywordCreateManyInput(adGroupId, optimizedKeywords) })
      : Promise.resolve();

    const [headlines, descriptions] = await Promise.all([headlinesTask, descriptionsTask, keywordsTask]);
    console.log(`[AdCopy] 完成: ${headlines.length} 标题, ${descriptions.length} 描述, ${optimizedKeywords.length} 关键词`);
  } catch (err) {
    console.error("[AdCopy] 广告文案生成异常:", err);
  } finally {
    adCopyGeneratingSet.delete(lockKey);
  }
}

/**
 * 异步触发文章生成（爬取商家 + AI 生成）
 * 1. 爬取商家网站获取图片、产品、卖点（与广告共享）
 * 2. AI 分析 + 生成推广文章
 * 3. 将爬取的图片同步写入 ad_creatives（广告可用）
 */
async function triggerArticleGeneration(
  userId: bigint,
  merchantId: bigint,
  articleId: bigint,
  adCreativeId: bigint,
  merchantName: string,
  merchantUrl: string,
  country: string,
  trackingLink: string,
) {
  try {
    const { analyzeUrl, generateMerchantArticle } = await import("@/lib/article-gen");

    const targetUrl = merchantUrl || `https://${merchantName.toLowerCase().replace(/\s+/g, "")}.com`;

    // Step 1: 爬取商家网站（图片 + 页面信息），数据供广告和文章共用
    let crawledImages: string[] = [];
    let crawledProducts: string[] = [];
    let crawledSellingPoints: string[] = [];
    let crawledLogoUrl = "";
    try {
      const { fetchPageImages, searchMerchantImages, crawlPage } = await import("@/lib/crawler");
      console.log(`[Article] 开始爬取商家网站: ${targetUrl}`);

      const [pageImgs, searchImgs, crawlResult] = await Promise.allSettled([
        fetchPageImages(targetUrl),
        searchMerchantImages(targetUrl, merchantName),
        crawlPage(targetUrl),
      ]);

      // 从 crawlPage 结果获取图片
      if (crawlResult.status === "fulfilled" && crawlResult.value?.images?.length > 0) {
        crawledImages.push(...crawlResult.value.images);
      }
      if (pageImgs.status === "fulfilled" && pageImgs.value.length > 0) {
        const newImgs = pageImgs.value.filter((img: string) => !crawledImages.includes(img));
        crawledImages.push(...newImgs);
      }
      if (searchImgs.status === "fulfilled" && searchImgs.value.length > 0) {
        const searchResults = searchImgs.value.filter((img: string) => !crawledImages.includes(img));
        crawledImages.push(...searchResults);
      }
      crawledImages = [...new Set(crawledImages)].slice(0, 20);

      // 从爬取的 HTML 中提取 logo
      if (crawlResult.status === "fulfilled" && crawlResult.value?.html) {
        const logoMatch = crawlResult.value.html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)/i)
          || crawlResult.value.html.match(/<meta[^>]+content=["']([^"']*?)["'][^>]+property=["']og:image["']/i);
        if (logoMatch?.[1]) crawledLogoUrl = logoMatch[1];
      }

      console.log(`[Article] 爬取完成: ${crawledImages.length} 张图片`);

      // 将爬取的图片同步写入 ad_creatives，供广告预览页使用
      if (crawledImages.length > 0 || crawledLogoUrl) {
        await prisma.ad_creatives.update({
          where: { id: adCreativeId },
          data: {
            ...(crawledImages.length > 0 ? { image_urls: crawledImages as any } : {}),
            ...(crawledLogoUrl ? { logo_url: crawledLogoUrl } : {}),
          },
        });
      }
    } catch (crawlErr) {
      console.warn("[Article] 爬取商家网站失败（将继续 AI 推断）:", crawlErr);
    }

    // Step 2: AI 分析商家 URL（推断品牌/品类/关键词/标题）
    const analysis = await analyzeUrl(targetUrl, country);
    console.log(`[Article] URL 分析完成: ${analysis.brandName}, ${analysis.category}`);

    // 合并爬虫数据和 AI 分析数据
    const products = crawledProducts.length > 0 ? crawledProducts : analysis.products;
    const sellingPoints = crawledSellingPoints.length > 0 ? crawledSellingPoints : analysis.sellingPoints;

    // 将卖点同步写入 ad_creatives
    if (sellingPoints.length > 0) {
      try {
        await prisma.ad_creatives.update({
          where: { id: adCreativeId },
          data: { selling_points: sellingPoints as any },
        });
      } catch { /* ignore */ }
    }

    // Step 3: 选择标题
    const title = analysis.titles[0]?.titleEn || analysis.titles[0]?.title || `${merchantName} Review`;

    // Step 4: 生成文章（使用共享的爬虫数据 + AI 分析数据）
    const article = await generateMerchantArticle({
      title,
      merchantName: analysis.brandName || merchantName,
      merchantUrl: merchantUrl || "",
      trackingLink: trackingLink || merchantUrl || "",
      country,
      products,
      sellingPoints,
      keywords: analysis.keywords,
      images: crawledImages.slice(0, 8),
      userId,
    });

    // Step 5: 更新文章记录（含 category）
    // 仅当文章尚无图片时才写入爬虫图，避免覆盖广告提交后已同步的最终选图
    const existingArticle = await prisma.articles.findUnique({
      where: { id: articleId },
      select: { images: true },
    });
    const hasExistingImages = Array.isArray(existingArticle?.images) && (existingArticle.images as string[]).length > 0;

    await prisma.articles.update({
      where: { id: articleId },
      data: {
        title,
        slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
        content: article.content,
        excerpt: article.excerpt,
        meta_title: article.metaTitle,
        meta_description: article.metaDescription,
        keywords: analysis.keywords as any,
        ...(!hasExistingImages && crawledImages.length > 0 ? { images: crawledImages.slice(0, 8) as any } : {}),
        category: article.category || analysis.category || "General",
        status: "preview",
      },
    });

    console.log(`[Article] 文章生成完成: "${title}"`);
  } catch (err) {
    console.error("[Article] 文章生成异常:", err);
    try {
      await prisma.articles.update({
        where: { id: articleId },
        data: { status: "failed" },
      });
    } catch {}
  }
}

/**
 * 自动关联 campaigns ↔ user_merchants 并认领
 * 当检测到有 campaigns 但无 claimed 商家时触发（数据一致性修复）
 *
 * 逻辑：
 * 1. 精确匹配：解析广告名 → ${platform}_${MID} 匹配 user_merchants
 * 2. 兜底匹配：仅用末尾纯数字 MID 匹配（不限平台）
 * 3. 将匹配到的商家标记为 claimed
 */
async function autoLinkAndClaimMerchants(userId: bigint) {
  const unlinked = await prisma.campaigns.findMany({
    where: { user_id: userId, user_merchant_id: BigInt(0), is_deleted: 0, google_campaign_id: { not: null } },
    select: { id: true, campaign_name: true },
    take: 500,
  });

  const userMerchants = await prisma.user_merchants.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true, platform: true, merchant_id: true, status: true },
  });

  if (userMerchants.length === 0) return;

  const merchantByKey = new Map(
    userMerchants.map((m) => [`${normalizePlatformCode(m.platform)}_${m.merchant_id}`, m])
  );
  const merchantByMid = new Map<string, typeof userMerchants[0]>();
  for (const m of userMerchants) {
    if (!merchantByMid.has(m.merchant_id)) merchantByMid.set(m.merchant_id, m);
  }

  const updates: Promise<unknown>[] = [];
  const claimedIds = new Set<bigint>();

  for (const c of unlinked) {
    if (!c.campaign_name) continue;
    const parts = c.campaign_name.split(/[-\s]+/);
    const mid = parts[parts.length - 1]?.trim();
    if (!mid || !/^\d+$/.test(mid)) continue;

    let matched: typeof userMerchants[0] | undefined;

    if (parts.length >= 4) {
      const rawPlatform = parts[1]?.trim();
      if (rawPlatform) {
        matched = merchantByKey.get(`${normalizePlatformCode(rawPlatform)}_${mid}`);
      }
    }

    if (!matched) {
      matched = merchantByMid.get(mid);
    }

    if (!matched) continue;

    updates.push(
      prisma.campaigns.update({ where: { id: c.id }, data: { user_merchant_id: matched.id } })
    );

    if (matched.status !== "claimed" && !claimedIds.has(matched.id)) {
      claimedIds.add(matched.id);
      updates.push(
        prisma.user_merchants.update({ where: { id: matched.id }, data: { status: "claimed", claimed_at: new Date() } })
      );
    }

    if (updates.length >= 20) {
      await Promise.all(updates.splice(0));
    }
  }

  // 已关联但未认领的商家也标记为 claimed
  const linkedIds = await prisma.campaigns.findMany({
    where: { user_id: userId, is_deleted: 0, user_merchant_id: { not: BigInt(0) }, google_campaign_id: { not: null } },
    select: { user_merchant_id: true },
    distinct: ["user_merchant_id"],
  });

  if (linkedIds.length > 0) {
    const ids = linkedIds.map((c) => c.user_merchant_id);
    updates.push(
      prisma.user_merchants.updateMany({
        where: { id: { in: ids }, user_id: userId, is_deleted: 0, status: { not: "claimed" } },
        data: { status: "claimed", claimed_at: new Date() },
      })
    );
  }

  if (updates.length > 0) await Promise.all(updates);
}

