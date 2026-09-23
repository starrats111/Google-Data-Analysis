/**
 * D-349 联调脚本：用真 Key 跑通 QUK / BA 的商家 + 交易 + 点击 + 打款四套接口，
 * 走的是 platform-api.ts / payment-api.ts 里真实的配置与解析路径（不是手写 curl），
 * 以此验证新增的 get_query / post_json_bearer 两种形态、字段映射、状态归一都对。
 *
 * 用法（Key 从环境变量传，不要写进文件）：
 *   QUK_KEY=xxx BA_KEY=yyy npx tsx scripts/d349-verify-quk-ba.ts
 */
import { fetchAllMerchants, fetchAllTransactions, fetchAllClicks } from "@/lib/platform-api";
import { fetchPlatformPayments, platformSupportsPayments } from "@/lib/payment-api";

const QUK_KEY = process.env.QUK_KEY || "";
const BA_KEY = process.env.BA_KEY || "";

function head(t: string) { console.log(`\n${"=".repeat(64)}\n${t}\n${"=".repeat(64)}`); }

function ymd(d: Date) { return d.toISOString().slice(0, 10); }

async function checkMerchants(platform: string, key: string) {
  head(`${platform} 商家`);
  const t0 = Date.now();
  const { merchants, error } = await fetchAllMerchants(platform, key);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (error) { console.log(`❌ error: ${error}`); return; }
  console.log(`✅ ${merchants.length} 家 / ${secs}s`);

  const notJoined = merchants.filter((m) => m.relationship_status !== "joined").length;
  console.log(`   非 joined 残留: ${notJoined}（应为 0）`);

  const noId = merchants.filter((m) => !m.merchant_id).length;
  const noName = merchants.filter((m) => !m.merchant_name).length;
  const noLink = merchants.filter((m) => !m.campaign_link).length;
  const noComm = merchants.filter((m) => !m.commission_rate).length;
  const withJoinDate = merchants.filter((m) => m.join_date).length;
  console.log(`   缺 merchant_id: ${noId} / 缺名称: ${noName}`);
  console.log(`   缺 campaign_link: ${noLink} / 缺佣金率: ${noComm} / 有入驻日期: ${withJoinDate}`);

  const s = merchants[0];
  if (s) {
    console.log(`   样本: id=${s.merchant_id} name=${s.merchant_name}`);
    console.log(`         comm=${JSON.stringify(s.commission_rate)} regions=${JSON.stringify(s.supported_regions)}`);
    console.log(`         cat=${JSON.stringify(s.category)}`);
    console.log(`         url=${s.merchant_url}`);
    console.log(`         logo=${(s.logo_url || "").slice(0, 60)}`);
    console.log(`         link=${(s.campaign_link || "").slice(0, 70)}`);
    console.log(`         join_date=${s.join_date} epc=${s.epc_30d}`);
  }
  // 佣金率里不该出现 BA 那个 "Contact for rates" 的占位 70%
  const susp70 = merchants.filter((m) => m.commission_rate === "70%").length;
  console.log(`   commission_rate === "70%" 的行: ${susp70}（BA 应为 0，占位值须被拦掉）`);
}

async function checkTxns(platform: string, key: string) {
  head(`${platform} 交易`);
  const end = new Date();
  const start = new Date(end.getTime() - 29 * 86400_000);
  const { transactions, error } = await fetchAllTransactions(platform, key, ymd(start), ymd(end));
  if (error) { console.log(`❌ error: ${error}`); return; }
  console.log(`✅ ${transactions.length} 条（${ymd(start)} ~ ${ymd(end)}）`);
  const byStatus: Record<string, number> = {};
  for (const t of transactions) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  console.log(`   状态分布: ${JSON.stringify(byStatus)}`);
  const s = transactions[0];
  if (s) {
    console.log(`   样本: id=${s.transaction_id} time=${s.transaction_time}`);
    console.log(`         merchant=${s.merchant}(${s.merchant_id}) 金额=${s.order_amount} 佣金=${s.commission_amount}`);
    console.log(`         status=${s.status} raw=${s.raw_status}`);
  } else {
    console.log("   （0 条：该账号这段时间没有订单，属预期；状态归一需等首批真实订单再核）");
  }
}

async function checkClicks(platform: string, key: string) {
  head(`${platform} 点击`);
  const end = new Date();
  const start = new Date(end.getTime() - 2 * 86400_000);
  const res = await fetchAllClicks(platform, key, `${ymd(start)} 00:00:00`, `${ymd(end)} 23:59:59`);
  if (res.error) { console.log(`❌ error: ${res.error}`); return; }
  const rows = res.clicks || [];
  console.log(`✅ ${rows.length} 行（${ymd(start)} ~ ${ymd(end)}）`);
  if (rows[0]) console.log(`   样本: ${JSON.stringify(rows[0])}`);
  else console.log("   （0 行：这几天没有点击，属预期——接口通、未报错即达标）");
}

async function checkPayments(platform: string, key: string) {
  head(`${platform} 打款`);
  if (!platformSupportsPayments(platform)) {
    console.log(`⏭  platformSupportsPayments=false（QUK 无打款接口，预期如此）`);
    return;
  }
  const end = new Date();
  const start = new Date(end.getTime() - 180 * 86400_000);
  const { payments, error } = await fetchPlatformPayments(platform, key, ymd(start), ymd(end));
  if (error) { console.log(`❌ error: ${error}`); return; }
  console.log(`✅ ${payments.length} 条（近 180 天）`);
  if (payments[0]) console.log(`   样本: ${JSON.stringify(payments[0]).slice(0, 300)}`);
  else console.log("   （0 条：该账号还没提现过，属预期）");
}

async function main() {
  if (QUK_KEY) {
    await checkMerchants("QUK", QUK_KEY);
    await checkTxns("QUK", QUK_KEY);
    await checkClicks("QUK", QUK_KEY);
    await checkPayments("QUK", QUK_KEY);
  } else console.log("跳过 QUK：未设 QUK_KEY");

  if (BA_KEY) {
    await checkMerchants("BA", BA_KEY);
    await checkTxns("BA", BA_KEY);
    await checkClicks("BA", BA_KEY);
    await checkPayments("BA", BA_KEY);
  } else console.log("跳过 BA：未设 BA_KEY");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
