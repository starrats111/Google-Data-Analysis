/**
 * 路线A（精确版）— 联盟平台「支付明细 / 佣金明细」API 客户端
 *
 * 与 payment-api.ts（打款单级金额）配套：本模块按「打款单/结算单号」拉取
 * 该笔打款内的**逐订单行级明细**，用于把对应交易在 affiliate_transactions
 * 标记为 paid，使「交易口径已付」精确等于真实到账。
 *
 * 三家明细接口（行级唯一ID = 我们库 affiliate_transactions.transaction_id）：
 *   LH: GET  mod=linkpayment&op=detail2   by withdrawal_id   → 行级键 sign_id
 *   RW: POST mod=commission&op=details    by withdrawal_id   → 行级键 sign_id (=rewardoo_id)
 *   LB: GET  mod=settlement&op=commission_details by payment_id → 行级键 linkbux_id
 */

export interface PaymentDetailItem {
  signId: string; // 行级唯一ID，对应 affiliate_transactions.transaction_id
  orderId: string | null;
  merchantId: string | null; // 平台商家标识（slug 或数字，按平台而异）
  cashback: number; // 该行佣金
  paymentNo: string; // 来源打款/结算单号
  paidDate: string | null;
  rawStatus: string;
}

export interface PaymentDetailResult {
  items: PaymentDetailItem[];
  error?: string;
}

const TIMEOUT = 60000;
const MAX_RETRIES = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseAmount(v: unknown): number {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/,/g, "").trim());
  return isNaN(n) ? 0 : n;
}

function toISO(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === "0" || s === "null") return null;
  if (/^\d{10}$/.test(s)) {
    const d = new Date(parseInt(s, 10) * 1000);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[\sT](\d{2}:\d{2}:\d{2}))?$/);
  if (m) {
    const d = new Date(`${m[1]}T${m[2] || "00:00:00"}Z`);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** 平台 code 提示：1002 = 调用频率过高（需退避重试） */
function apiCodeOf(data: Record<string, unknown>): string {
  const top = data.code;
  if (top != null) return String(top);
  const st = data.status as Record<string, unknown> | undefined;
  if (st && typeof st === "object" && st.code != null) return String(st.code);
  return "0";
}

/**
 * 带重试 + 限频退避的 JSON 请求。
 * 平台 code=1002（频率过高）会指数退避重试，而非直接失败。
 */
async function fetchJson(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Record<string, unknown>> {
  let lastErr = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const resp = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      const text = await resp.text();
      if (!resp.ok) {
        lastErr = `HTTP ${resp.status}`;
      } else if (!text || !text.trim()) {
        lastErr = "空响应";
      } else {
        let json: Record<string, unknown> | null = null;
        try {
          json = JSON.parse(text) as Record<string, unknown>;
        } catch {
          lastErr = `非 JSON 响应: ${text.slice(0, 120)}`; // 限频常返回 HTML，退避重试
        }
        if (json) {
          const code = apiCodeOf(json);
          if (code === "1002") {
            lastErr = "1002 调用频率过高";
          } else {
            return json;
          }
        }
      }
    } catch (err) {
      clearTimeout(timer);
      lastErr = err instanceof Error ? err.message : String(err);
    }
    if (attempt < MAX_RETRIES) await sleep((attempt + 1) * 3000);
  }
  throw new Error(`${label} 失败: ${lastErr}`);
}

// ── LH: linkpayment&op=detail2 (by withdrawal_id) ──────────────
async function fetchLhDetail(token: string, withdrawalId: string): Promise<PaymentDetailItem[]> {
  const out: PaymentDetailItem[] = [];
  let page = 1;
  const perPage = 2000;
  while (page <= 100) {
    const url = `https://www.linkhaitao.com/api.php?mod=linkpayment&op=detail2&token=${encodeURIComponent(
      token,
    )}&withdrawal_id=${encodeURIComponent(withdrawalId)}&per_page=${perPage}&page=${page}`;
    const data = await fetchJson(url, { method: "GET" }, `LH detail2 wd=${withdrawalId}`);
    const list = ((data.list ?? data.data) || []) as Record<string, unknown>[];
    if (!Array.isArray(list) || list.length === 0) break;
    for (const it of list) {
      const signId = String(it.sign_id ?? "").trim();
      if (!signId) continue;
      out.push({
        signId,
        orderId: it.order_id != null ? String(it.order_id) : null,
        merchantId: it.m_id != null ? String(it.m_id) : null,
        cashback: parseAmount(it.cashback),
        paymentNo: withdrawalId,
        paidDate: toISO(it.report_time),
        rawStatus: String(it.status ?? ""),
      });
    }
    if (list.length < perPage) break;
    page++;
    await sleep(1500);
  }
  return out;
}

// ── RW: commission&op=details (by withdrawal_id, POST form) ────
async function fetchRwDetail(token: string, withdrawalId: string): Promise<PaymentDetailItem[]> {
  const form = new URLSearchParams();
  form.set("token", token);
  form.set("withdrawal_id", withdrawalId);
  const data = await fetchJson(
    "https://admin.rewardoo.com/api.php?mod=commission&op=details",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    },
    `RW details wd=${withdrawalId}`,
  );
  const list = (data.data || []) as Record<string, unknown>[];
  if (!Array.isArray(list)) return [];
  const out: PaymentDetailItem[] = [];
  for (const it of list) {
    const signId = String(it.sign_id ?? "").trim();
    if (!signId) continue;
    out.push({
      signId,
      orderId: it.order_id != null ? String(it.order_id) : null,
      merchantId: it.mid != null ? String(it.mid) : null,
      cashback: parseAmount(it.cashback),
      paymentNo: withdrawalId,
      paidDate: toISO(it.report_time ?? it.order_time),
      rawStatus: String(it.status ?? ""),
    });
  }
  return out;
}

// ── LB: settlement&op=commission_details (by payment_id) ───────
async function fetchLbDetail(token: string, paymentId: string): Promise<PaymentDetailItem[]> {
  const out: PaymentDetailItem[] = [];
  let page = 1;
  const limit = 1000;
  while (page <= 200) {
    const params = new URLSearchParams({
      token,
      payment_id: paymentId,
      type: "json",
      page: String(page),
      limit: String(limit),
    });
    const data = await fetchJson(
      `https://www.linkbux.com/api.php?mod=settlement&op=commission_details&${params}`,
      { method: "GET" },
      `LB commission_details pay=${paymentId}`,
    );
    const list = (data.data || []) as Record<string, unknown>[];
    if (!Array.isArray(list) || list.length === 0) break;
    for (const it of list) {
      const signId = String(it.linkbux_id ?? "").trim();
      if (!signId) continue;
      // commission_details 会返回该 payment_id 下各状态的行（含 Returned/Pending 等未实付）；
      // 仅保留真正已打款的行（payment_status=Paid 或有 paid_date），使明细合计=实付。
      const payStatus = String(it.payment_status ?? "").toLowerCase();
      const hasPaidDate = !!toISO(it.paid_date);
      if (!payStatus.includes("paid") && !hasPaidDate) continue;
      out.push({
        signId,
        orderId: it.order_id != null ? String(it.order_id) : null,
        merchantId: it.mcid != null ? String(it.mcid) : it.mid != null ? String(it.mid) : null,
        cashback: parseAmount(it.sale_comm),
        paymentNo: paymentId,
        paidDate: toISO(it.paid_date),
        rawStatus: String(it.payment_status ?? it.status ?? ""),
      });
    }
    if (list.length < limit) break;
    page++;
    await sleep(1500);
  }
  return out;
}

export function platformSupportsPaymentDetail(platform: string): boolean {
  return platform === "LH" || platform === "RW" || platform === "LB";
}

/**
 * 拉取单笔打款/结算单的行级明细。
 * @param paymentNo LH/RW = withdrawal_id；LB = payment_id
 */
export async function fetchPaymentDetail(
  platform: string,
  token: string,
  paymentNo: string,
): Promise<PaymentDetailResult> {
  try {
    if (platform === "LH") return { items: await fetchLhDetail(token, paymentNo) };
    if (platform === "RW") return { items: await fetchRwDetail(token, paymentNo) };
    if (platform === "LB") return { items: await fetchLbDetail(token, paymentNo) };
    return { items: [] };
  } catch (err) {
    return { items: [], error: err instanceof Error ? err.message : String(err) };
  }
}
