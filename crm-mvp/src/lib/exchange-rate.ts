import prisma from "@/lib/prisma";

const rateCache = new Map<string, number>();

function cacheKey(currency: string, dateStr: string): string {
  return `${currency.toUpperCase()}_${dateStr}`;
}

/**
 * 获取指定币种在指定日期的 → USD 汇率。
 * 查询顺序：内存缓存 → 数据库快照 → API（结果写入快照）→ 最近快照兜底。
 */
export async function getExchangeRate(currency: string, dateStr: string): Promise<number> {
  if (!currency || currency.toUpperCase() === "USD") return 1;
  const cur = currency.toUpperCase();
  const key = cacheKey(cur, dateStr);

  const cached = rateCache.get(key);
  if (cached) return cached;

  const dateObj = new Date(dateStr);

  const snapshot = await prisma.exchange_rate_snapshots.findUnique({
    where: { currency_date: { currency: cur, date: dateObj } },
  });
  if (snapshot) {
    const rate = Number(snapshot.rate_to_usd);
    rateCache.set(key, rate);
    return rate;
  }

  const apiRate = await fetchRateFromApi(cur);
  if (apiRate > 0) {
    try {
      await prisma.exchange_rate_snapshots.create({
        data: { currency: cur, date: dateObj, rate_to_usd: apiRate },
      });
    } catch {
      // currency_date 唯一约束冲突时忽略（并发写入）
    }
    rateCache.set(key, apiRate);
    return apiRate;
  }

  const nearest = await prisma.exchange_rate_snapshots.findFirst({
    where: { currency: cur },
    orderBy: { date: "desc" },
  });
  if (nearest) {
    const rate = Number(nearest.rate_to_usd);
    rateCache.set(key, rate);
    return rate;
  }

  console.error(`[ExchangeRate] 无法获取 ${cur} 汇率，无快照可用`);
  return 1;
}

/**
 * 批量预加载一段日期范围内的汇率快照到内存缓存，减少数据库查询。
 */
export async function preloadRates(currency: string, startDate: string, endDate: string): Promise<void> {
  if (!currency || currency.toUpperCase() === "USD") return;
  const cur = currency.toUpperCase();
  const snapshots = await prisma.exchange_rate_snapshots.findMany({
    where: {
      currency: cur,
      date: { gte: new Date(startDate), lte: new Date(endDate) },
    },
  });
  for (const s of snapshots) {
    const d = s.date.toISOString().split("T")[0];
    rateCache.set(cacheKey(cur, d), Number(s.rate_to_usd));
  }
}

async function fetchRateFromApi(currency: string): Promise<number> {
  try {
    const resp = await fetch(
      `https://open.er-api.com/v6/latest/${currency}`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (!resp.ok) return 0;
    const data = await resp.json();
    const rate = data.rates?.USD;
    if (!rate || rate <= 0) return 0;
    console.log(`[ExchangeRate] API ${currency} → USD = ${rate}`);
    return rate;
  } catch (err) {
    console.error(`[ExchangeRate] API 失败 ${currency}:`, err);
    return 0;
  }
}
