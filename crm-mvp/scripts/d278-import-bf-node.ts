/**
 * D-278：节点商家清单导入（服务器一次性执行，与管理端导入接口共用同一套入库逻辑）
 *
 * 记录 JSON 由本地从联盟官方 Excel 解析生成后 scp 上来，格式：
 *   [{ merchant_name, mcid, mid, affiliate, website, merchant_base, epc,
 *      commission_cap, avg_commission_rate, avg_order_commission }, ...]
 *
 * 用法（生产服务器 crm-mvp 目录）：
 *   npx tsx scripts/d278-import-bf-node.ts --node=black_friday --file=/tmp/d278_bf_records.json
 */
process.loadEnvFile(".env");
import { readFileSync } from "fs";

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) args.set(m[1], m[2]);
}
const NODE_CODE = args.get("node") || "";
const FILE = args.get("file") || "";

async function main() {
  if (!NODE_CODE || !FILE) throw new Error("用法：--node=black_friday --file=/tmp/d278_bf_records.json");
  const { default: prisma } = await import("../src/lib/prisma");
  const { replaceNodeMerchants } = await import("../src/lib/holiday-nodes");

  const node = await prisma.holiday_nodes.findUnique({ where: { code: NODE_CODE } });
  if (!node || node.is_deleted) throw new Error(`节点 "${NODE_CODE}" 不存在，先跑迁移或在管理页创建`);

  const records = JSON.parse(readFileSync(FILE, "utf-8"));
  if (!Array.isArray(records) || records.length === 0) throw new Error("记录文件为空，不做任何改动");
  for (const r of records) {
    if (!r.merchant_name || String(r.merchant_name).length < 2) throw new Error(`存在无名记录，整批拒绝：${JSON.stringify(r).slice(0, 100)}`);
  }

  const result = await replaceNodeMerchants(NODE_CODE, records);
  console.log(`节点「${node.name}」导入完成：解析 ${result.parsed} 行 → 去重写入 ${result.inserted} 个商家（替换旧清单 ${result.deleted} 条），批次 ${result.batch}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error("导入失败：", e); process.exit(1); });
