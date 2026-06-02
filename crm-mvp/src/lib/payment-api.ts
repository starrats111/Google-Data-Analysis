/**
 * D-072 联盟平台「支付/打款」API 客户端
 *
 * 与 platform-api.ts（商家 / 交易）并列，专门拉取各平台「已支付/打款」记录。
 * 三种接口形态：
 *   1. payment_summary（打款单级）：CG / PM / BSH / CF / MUI / EV
 *      POST JSON {source, token, paidDateBegin, paidDateEnd, curPage, perPage}
 *      → data.list[]: {payment_id, paid_date, request_date, amount, status:"paid", payment_type}
 *   2. withdrawal（提现级）：RW / LH
 *      RW: POST form  mod=commission&op=payments     → data[]: {withdrawal_id, withdrawal_time, update_time, commission, withdrawal_amount, status}
 *      LH: GET        mod=linkpayment&op=payment2     → data[]: {withdrawal_id, created_date, payment_date, paid_status, total, service_fee}
 *   3. merchant_commission（按商家已付佣金）：LB
 *      GET  mod=settlement&op=merchant_commission（begin_date/end_date ≤ 62 天）
 *      → data[]: {payment_id, paid_date, sale_comm, mcid, merchant_name, settlement_uuid}
 *
 * 说明：RW/LH 提现级金额无法拆到商家/交易月，仅平台级统计（结算率分子）。
 */

export type PaymentSourceKind = "payment_summary" | "withdrawal" | "merchant_commission";

export interface PlatformPayment {
  payment_no: string;
  source_kind: PaymentSourceKind;
  paid_date?: string | null; // ISO，实际打款日
  request_date?: string | null; // ISO，打款单创建日
  amount: number; // 实付佣金
  gross_amount?: number | null; // 提现总额（含手续费）
  currency: string;
  status: string; // 归一化：paid | processing | rejected
  raw_status?: string;
  payment_type?: string | null;
  raw_json?: string;
}

const PAYMENT_SUMMARY_HOSTS: Record<string, { host: string; source: string }> = {
  CG: { host: "api.collabglow.com", source: "collabglow" },
  PM: { host: "api.partnermatic.com", source: "partnermatic" },
  BSH: { host: "api.brandsparkhub.com", source: "brandsparkhub" },
  CF: { host: "api.creatorflare.com", source: "creatorflare" },
  MUI: { host: "api.ultrainfluence.com", source: "ultrainfluence" },
  EV: { host: "api.engagevantage.com", source: "engagevantage" },
};

const PAYMENT_API_TIMEOUT = 60000;
const PAYMENT_API_MAX_RETRIES = 2;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 去除千分位逗号后解析为 number；无效返回 0 */
function parseAmount(v: unknown): number {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/,/g, "").trim());
  return isNaN(n) ? 0 : n;
}

/** 把平台返回的支付状态归一化为 paid | processing | rejected */
function normalizePaymentStatus(raw: string | null | undefined): string {
  const s = String(raw ?? "").toLowerCase().trim();
  if (!s) return "paid"; // payment_summary 早期版本无 status 字段，默认视为已付
  if (/(paid|success|withdrawn|settled|complete|done)/.test(s)) return "paid";
  if (/(processing|pending|review|wait|progress|created|requested)/.test(s)) return "processing";
  if (/(reject|fail|declin|cancel|void|invalid|refus)/.test(s)) return "rejected";
  return "paid";
}

/** 解析多种日期格式 → ISO（无时区按 UTC 处理，与 platform-api 一致） */
function toISO(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === "0" || s === "null") return null;
  // Unix 秒
  if (/^\d{10}$/.test(s)) {
    const d = new Date(parseInt(s, 10) * 1000);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  // "YYYY-MM-DD HH:MM:SS" / "YYYY-MM-DD"
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[\sT](\d{2}:\d{2}:\d{2}))?$/);
  if (m) {
    const d = new Date(`${m[1]}T${m[2] || "00:00:00"}Z`);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt <= PAYMENT_API_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAYMENT_API_TIMEOUT);
    try {
      const resp = await fetch(url, { ...init, signal: controller.signal });
      if (!resp.ok) {
        if (RETRYABLE_STATUS.has(resp.status) && attempt < PAYMENT_API_MAX_RETRIES) {
          clearTimeout(timer);
          await sleep((attempt + 1) * 2000);
          continue;
        }
        throw new Error(`HTTP ${resp.status}`);
      }
      const text = await resp.text();
      if (!text || !text.trim()) throw new Error("空响应");
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error(`非 JSON 响应: ${text.slice(0, 120)}`);
      }
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
      if (attempt < PAYMENT_API_MAX_RETRIES && isAbort) {
        await sleep((attempt + 1) * 2000);
        continue;
      }
      if (attempt >= PAYMENT_API_MAX_RETRIES) {
        throw new Error(`${label} 请求失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${label} 超过最大重试次数`);
}

/** 检查平台返回的 code/status 是否成功 */
function checkApiCode(data: Record<string, unknown>): string | null {
  // payment_summary: {code:"0"} ; LH/LB/RW: {status:{code:0}}
  const topCode = data.code;
  if (topCode != null && String(topCode) !== "0") {
    return String(data.message || data.msg || `code=${topCode}`);
  }
  const st = data.status as Record<string, unknown> | undefined;
  if (st && typeof st === "object" && st.code != null && String(st.code) !== "0") {
    return String(st.msg || st.message || `code=${st.code}`);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 1. payment_summary 家族（CG/PM/BSH/CF/MUI/EV）
// ─────────────────────────────────────────────────────────────
async function fetchPaymentSummary(
  platform: string,
  token: string,
  startDate: string,
  endDate: string,
): Promise<PlatformPayment[]> {
  const cfg = PAYMENT_SUMMARY_HOSTS[platform];
  if (!cfg) return [];
  const url = `https://${cfg.host}/api/payment_summary`;
  const out: PlatformPayment[] = [];
  const perPage = 2000;
  let page = 1;
  let totalItems = Infinity;

  while ((page - 1) * perPage < totalItems) {
    const data = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: cfg.source,
          token,
          paidDateBegin: startDate,
          paidDateEnd: endDate,
          curPage: page,
          perPage,
        }),
      },
      `${platform} payment_summary`,
    );
    const apiErr = checkApiCode(data);
    if (apiErr) throw new Error(apiErr);

    const root = (data.data || {}) as Record<string, unknown>;
    const list = (root.list || []) as Record<string, unknown>[];
    totalItems = Number(root.total_items ?? root.totalItems ?? list.length);
    if (!Array.isArray(list) || list.length === 0) break;

    for (const it of list) {
      const paymentNo = String(it.payment_id ?? it.paymentId ?? "").trim();
      if (!paymentNo) continue;
      const rawStatus = (it.status ?? "") as string;
      out.push({
        payment_no: paymentNo,
        source_kind: "payment_summary",
        paid_date: toISO(it.paid_date ?? it.paidDate),
        request_date: toISO(it.request_date ?? it.requestDate),
        amount: parseAmount(it.amount),
        gross_amount: null,
        currency: "USD",
        status: normalizePaymentStatus(rawStatus),
        raw_status: String(rawStatus || ""),
        payment_type: (it.payment_type ?? it.paymentType ?? null) as string | null,
        raw_json: JSON.stringify(it),
      });
    }
    if (list.length < perPage) break;
    page++;
    if (page > 50) break; // 安全上限
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 2a. RW 提现（commission&op=payments）
// ─────────────────────────────────────────────────────────────
async function fetchRewardooPayments(
  token: string,
  startDate: string,
  endDate: string,
): Promise<PlatformPayment[]> {
  const form = new URLSearchParams();
  form.set("token", token);
  form.set("payment_begin", startDate);
  form.set("payment_end", endDate);
  const data = await fetchWithRetry(
    "https://admin.rewardoo.com/api.php?mod=commission&op=payments",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    },
    "RW payments",
  );
  const apiErr = checkApiCode(data);
  if (apiErr) throw new Error(apiErr);

  const list = (data.data || []) as Record<string, unknown>[];
  if (!Array.isArray(list)) return [];
  const out: PlatformPayment[] = [];
  for (const it of list) {
    const paymentNo = String(it.withdrawal_id ?? "").trim();
    if (!paymentNo) continue;
    const rawStatus = (it.status ?? "") as string;
    out.push({
      payment_no: paymentNo,
      source_kind: "withdrawal",
      paid_date: toISO(it.update_time ?? it.withdrawal_time),
      request_date: toISO(it.withdrawal_time),
      amount: parseAmount(it.commission),
      gross_amount: parseAmount(it.withdrawal_amount),
      currency: "USD",
      status: normalizePaymentStatus(rawStatus),
      raw_status: String(rawStatus || ""),
      payment_type: (it.bank_name ?? null) as string | null,
      raw_json: JSON.stringify(it),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 2b. LH 提现（linkpayment&op=payment2）
// ─────────────────────────────────────────────────────────────
async function fetchLinkhaitaoPayments(
  token: string,
  startDate: string,
  endDate: string,
): Promise<PlatformPayment[]> {
  const params = new URLSearchParams({
    token,
    payment_begin: startDate,
    payment_end: endDate,
  });
  const data = await fetchWithRetry(
    `https://www.linkhaitao.com/api.php?mod=linkpayment&op=payment2&${params}`,
    { method: "GET" },
    "LH payment2",
  );
  const apiErr = checkApiCode(data);
  if (apiErr) throw new Error(apiErr);

  const list = (data.data || []) as Record<string, unknown>[];
  if (!Array.isArray(list)) return [];
  const out: PlatformPayment[] = [];
  for (const it of list) {
    const paymentNo = String(it.withdrawal_id ?? "").trim();
    if (!paymentNo) continue;
    const rawStatus = (it.paid_status ?? "") as string;
    const total = parseAmount(it.total);
    out.push({
      payment_no: paymentNo,
      source_kind: "withdrawal",
      paid_date: toISO(it.payment_date),
      request_date: toISO(it.created_date),
      amount: total,
      gross_amount: total,
      currency: "USD",
      status: normalizePaymentStatus(rawStatus),
      raw_status: String(rawStatus || ""),
      payment_type: (it.bank_name ?? null) as string | null,
      raw_json: JSON.stringify(it),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 3. LB 按商家已付佣金（settlement&op=merchant_commission）
//    begin_date/end_date 跨度 ≤ 62 天，需分片；按 settlement 周期分窗，
//    取 paid_date 非空的行，按 payment_id 聚合 sale_comm。
// ─────────────────────────────────────────────────────────────
function chunkDateRange(startDate: string, endDate: string, maxDays: number): Array<{ s: string; e: string }> {
  const out: Array<{ s: string; e: string }> = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return [{ s: startDate, e: endDate }];
  let cur = start;
  while (cur <= end) {
    const chunkEnd = new Date(cur.getTime() + (maxDays - 1) * 86400000);
    const e = chunkEnd > end ? end : chunkEnd;
    out.push({ s: cur.toISOString().slice(0, 10), e: e.toISOString().slice(0, 10) });
    cur = new Date(e.getTime() + 86400000);
  }
  return out;
}

async function fetchLinkbuxMerchantCommission(
  token: string,
  startDate: string,
  endDate: string,
): Promise<PlatformPayment[]> {
  // 按 payment_id 聚合（同一笔打款可能跨多商家行）
  const agg = new Map<string, { amount: number; paid_date: string | null; settlement_date: string | null; rows: number }>();

  const chunks = chunkDateRange(startDate, endDate, 60);
  for (const { s, e } of chunks) {
    const params = new URLSearchParams({ token, begin_date: s, end_date: e, type: "json" });
    let data: Record<string, unknown>;
    try {
      data = await fetchWithRetry(
        `https://www.linkbux.com/api.php?mod=settlement&op=merchant_commission&${params}`,
        { method: "GET" },
        "LB merchant_commission",
      );
    } catch {
      continue; // 单窗失败不影响其他窗
    }
    const apiErr = checkApiCode(data);
    if (apiErr) continue;

    const list = (data.data || []) as Record<string, unknown>[];
    if (!Array.isArray(list)) continue;
    for (const it of list) {
      const paidDate = toISO(it.paid_date);
      const paymentId = String(it.payment_id ?? "").trim();
      // 仅统计已付（paid_date 非空且 payment_id 有效）
      if (!paidDate || !paymentId || paymentId === "0") continue;
      const cur = agg.get(paymentId) ?? { amount: 0, paid_date: paidDate, settlement_date: toISO(it.settlement_date), rows: 0 };
      cur.amount += parseAmount(it.sale_comm);
      cur.paid_date = cur.paid_date || paidDate;
      cur.rows++;
      agg.set(paymentId, cur);
    }
    await sleep(300); // 轻微限速
  }

  const out: PlatformPayment[] = [];
  for (const [paymentId, v] of agg) {
    out.push({
      payment_no: paymentId,
      source_kind: "merchant_commission",
      paid_date: v.paid_date,
      request_date: v.settlement_date,
      amount: +v.amount.toFixed(2),
      gross_amount: null,
      currency: "USD",
      status: "paid",
      raw_status: "paid",
      payment_type: null,
      raw_json: JSON.stringify({ payment_id: paymentId, merchant_rows: v.rows }),
    });
  }
  return out;
}

/** 该平台是否支持支付 API */
export function platformSupportsPayments(platform: string): boolean {
  return (
    !!PAYMENT_SUMMARY_HOSTS[platform] || platform === "RW" || platform === "LH" || platform === "LB"
  );
}

/**
 * 拉取单个平台在 [startDate, endDate]（YYYY-MM-DD，按打款/结算周期）内的支付记录。
 * AD 等无支付 API 的平台返回空。
 */
export async function fetchPlatformPayments(
  platform: string,
  token: string,
  startDate: string,
  endDate: string,
): Promise<{ payments: PlatformPayment[]; error?: string }> {
  try {
    if (PAYMENT_SUMMARY_HOSTS[platform]) {
      return { payments: await fetchPaymentSummary(platform, token, startDate, endDate) };
    }
    if (platform === "RW") return { payments: await fetchRewardooPayments(token, startDate, endDate) };
    if (platform === "LH") return { payments: await fetchLinkhaitaoPayments(token, startDate, endDate) };
    if (platform === "LB") return { payments: await fetchLinkbuxMerchantCommission(token, startDate, endDate) };
    return { payments: [] }; // AD 等无支付 API
  } catch (err) {
    return { payments: [], error: err instanceof Error ? err.message : String(err) };
  }
}
