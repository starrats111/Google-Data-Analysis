/**
 * C-094.8 关注广告主的「活跃域名 + 命中商家」查询
 *
 * GET /api/user/atc/watchlist/{id}/active-domains
 *   返回该关注广告主当前满足：
 *     - 单创意持续投放天数 ≥ watchlist.min_days
 *     - 最近投放时间在近 2 天内（即"昨天/今天还在投"，ATC 数据一般有 1 天延迟）
 *   的域名详情，并 LEFT JOIN 当前用户 user_merchants 表，
 *   匹配 merchant_url 包含 domain 的 CRM 商家（用于直接跳「我的商家」搜索）
 *
 * 数据来源：atc_advertiser_domain_snapshot.sampled_ads_json + ad_image_ocr_cache
 *   - 不调 SerpApi（仅浏览态，避免重复消耗配额）
 *   - 若 snapshot 不存在或 sampled 为空 → 返回空列表 + hint 提示先在 ATC 详情查询
 */
import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

// 近 2 天判定窗口（秒）：48 小时容忍 ATC 数据延迟
const RECENT_WINDOW_SEC = 2 * 86400;

interface SampledAd {
  image: string;
  first_shown?: number;
  last_shown?: number;
}

/** 把任意 URL/裸 domain 归一为不带协议、不带 www、小写的 domain 字符串 */
function normalizeDomain(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.split("/")[0];
  s = s.split("?")[0];
  return s;
}

/** 两个 domain 是否"匹配"——任一方包含另一方的核心域名片段即可（容忍 www / 子目录） */
function domainMatches(adDomain: string, merchantUrl: string): boolean {
  const a = normalizeDomain(adDomain);
  const m = normalizeDomain(merchantUrl);
  if (!a || !m) return false;
  return a === m || a.includes(m) || m.includes(a);
}

export const GET = withUser(async (_req: NextRequest, { user, params }) => {
  const userId = BigInt(user.userId);
  const idStr = params?.id;
  if (!idStr) {
    return NextResponse.json({ code: -1, message: "缺少 id" }, { status: 400 });
  }
  const id = BigInt(idStr);

  // 1. 取 watchlist 并校验归属
  const w = await prisma.user_atc_watchlist.findUnique({ where: { id } });
  if (!w || w.user_id !== userId) {
    return NextResponse.json({ code: -1, message: "未找到该关注" }, { status: 404 });
  }
  if (w.is_deleted === 1) {
    return NextResponse.json({ code: -1, message: "该关注已取消" }, { status: 400 });
  }

  // 2. 取对应的广告主 snapshot
  const snap = await prisma.atc_advertiser_domain_snapshot.findUnique({
    where: { advertiser_id_region: { advertiser_id: w.advertiser_id, region: w.region } },
  });

  if (!snap) {
    return NextResponse.json({
      code: 0,
      data: {
        advertiser_id: w.advertiser_id,
        advertiser_name: w.advertiser_name,
        region: w.region,
        min_days: w.min_days,
        items: [],
        ocr_pending: false,
        hint: "尚未在 ATC 详情里查询过该广告主，请先到「我的商家 → 选取商家 → ATC 详情」打开一次以建立快照",
      },
    });
  }

  const sampledAds = (snap.sampled_ads_json as SampledAd[] | null) ?? [];
  if (sampledAds.length === 0) {
    return NextResponse.json({
      code: 0,
      data: {
        advertiser_id: w.advertiser_id,
        advertiser_name: snap.advertiser_name,
        region: w.region,
        min_days: w.min_days,
        items: [],
        ocr_pending: snap.ocr_pending === 1,
        hint: "该广告主无可用采样数据，请等待 OCR 完成后再试",
      },
    });
  }

  // 3. 拉 OCR cache 已识别出的 domain
  const imageUrls = sampledAds.map((a) => a.image).filter((u) => typeof u === "string");
  const ocrRows = await prisma.ad_image_ocr_cache.findMany({
    where: { image_url: { in: imageUrls }, status: "success" },
    select: { image_url: true, extracted_domain: true },
  });
  const urlToDomain = new Map<string, string>();
  for (const r of ocrRows) {
    if (r.extracted_domain) urlToDomain.set(r.image_url, r.extracted_domain);
  }

  // 4. 按 domain 聚合 max_creative_days / last_shown_ts / creative_count
  const stats = new Map<string, {
    domain: string;
    max_creative_days: number;
    last_shown_ts: number;
    first_shown_ts: number;
    creative_count: number;
  }>();
  for (const ad of sampledAds) {
    const domain = urlToDomain.get(ad.image);
    if (!domain) continue;
    let s = stats.get(domain);
    if (!s) {
      s = { domain, max_creative_days: 0, last_shown_ts: 0, first_shown_ts: 0, creative_count: 0 };
      stats.set(domain, s);
    }
    s.creative_count++;
    if (typeof ad.first_shown === "number" && typeof ad.last_shown === "number" && ad.last_shown > ad.first_shown) {
      const days = Math.floor((ad.last_shown - ad.first_shown) / 86400);
      if (days > s.max_creative_days) s.max_creative_days = days;
      if (ad.last_shown > s.last_shown_ts) {
        s.last_shown_ts = ad.last_shown;
        s.first_shown_ts = ad.first_shown;
      }
    }
  }

  // 5. 过滤：max_days ≥ min_days && last_shown 在近 2 天内
  const minDays = w.min_days;
  const nowSec = Math.floor(Date.now() / 1000);
  const recentCutoff = nowSec - RECENT_WINDOW_SEC;
  const qualifying = Array.from(stats.values())
    .filter((s) => s.max_creative_days >= minDays && s.last_shown_ts >= recentCutoff)
    .sort((a, b) => b.max_creative_days - a.max_creative_days);

  // 6. LEFT JOIN：找出 user_merchants 里 merchant_url 与每个 domain 匹配的商家
  const userMerchants = await prisma.user_merchants.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true, merchant_name: true, platform: true, merchant_url: true, status: true, merchant_id: true },
  });

  const items = qualifying.map((s) => {
    const matched = userMerchants.find((m) => m.merchant_url && domainMatches(s.domain, m.merchant_url));
    return {
      domain: s.domain,
      max_creative_days: s.max_creative_days,
      last_shown_ts: s.last_shown_ts,
      first_shown_ts: s.first_shown_ts,
      creative_count: s.creative_count,
      merchant: matched
        ? {
            id: matched.id.toString(),
            merchant_id: matched.merchant_id,
            name: matched.merchant_name,
            platform: matched.platform,
            url: matched.merchant_url,
            status: matched.status,
          }
        : null,
    };
  });

  // 7. 同时返回"全部域名"列表用于 fallback 展示（即使未通过近 2 天判定，但用户可能想看）
  const allDomains = Array.from(stats.values())
    .sort((a, b) => b.max_creative_days - a.max_creative_days)
    .map((s) => {
      const matched = userMerchants.find((m) => m.merchant_url && domainMatches(s.domain, m.merchant_url));
      return {
        domain: s.domain,
        max_creative_days: s.max_creative_days,
        last_shown_ts: s.last_shown_ts,
        first_shown_ts: s.first_shown_ts,
        creative_count: s.creative_count,
        qualifying: s.max_creative_days >= minDays && s.last_shown_ts >= recentCutoff,
        merchant: matched
          ? {
              id: matched.id.toString(),
              merchant_id: matched.merchant_id,
              name: matched.merchant_name,
              platform: matched.platform,
              url: matched.merchant_url,
              status: matched.status,
            }
          : null,
      };
    });

  return NextResponse.json({
    code: 0,
    data: {
      advertiser_id: w.advertiser_id,
      advertiser_name: snap.advertiser_name,
      region: w.region,
      min_days: minDays,
      items,
      all_domains: allDomains,
      ocr_pending: snap.ocr_pending === 1,
      sampled_count: sampledAds.length,
      ocr_success_count: ocrRows.length,
    },
  });
});
