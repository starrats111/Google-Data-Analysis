/**
 * D-278：海外节点推荐投放——共享逻辑
 *
 * 节点清单行落 merchant_recommendations，source='node' + node_code 标识：
 * 与 excel（全量替换）/ sheets / atc 三个既有通道互不干扰；
 * 替换粒度是"单个节点"（重传黑五清单只动 node_code='black_friday' 的行）。
 *
 * 提醒（07 七问拍板）：节点前 lead_days（默认 30）天起，全员站内通知一次；
 * notified_at 防重发，判定窗口随 node_date 移动——管理员把节点改到下一届日期后自动复位。
 */
import prisma from "@/lib/prisma";
import { todayCST } from "@/lib/date-utils";

export const NODE_SOURCE = "node";

export interface NodeMerchantRecord {
  merchant_name: string;
  mcid: string | null;
  mid: string | null;
  affiliate: string | null;
  website: string | null;
  merchant_base: string | null;
  epc: number | null;
  commission_cap: string | null;
  avg_commission_rate: number | null;
  avg_order_commission: number | null;
}

function safeStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function safeNum(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "" || s === "-" || s === "N/A") return null;
  const n = parseFloat(s.replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? null : n;
}

/** 提取国家代码，如 "美国(US)" → "US" */
function extractCountryCode(base: string): string {
  const match = base.match(/\(([A-Z]{2,3})\)/);
  return match ? match[1] : base.trim();
}

/**
 * 解析节点商家 Excel 行，支持两种表头：
 * - LH 节点清单格式（黑五清单实样，9 列）：BU / Mcid / MID / BU 商家名称 / Website / 下单地区 / 媒体 EPC / 媒体佣金比例 / 媒体每单平均佣金
 *   （无"联盟"与"佣金上限"列，联盟取 BU 列值；靠表头含"下单地区"或"媒体"识别）
 * - 标准推荐清单格式（与 merchant-excel-upload 相同，10/11 列）：[BU] / mcid / MID / 名称 / 联盟 / 网址 / 商家地区 / EPC / 佣金上限 / 平均佣金率 / 平均带单佣金
 */
export function parseNodeExcelRows(rows: unknown[][]): NodeMerchantRecord[] {
  // 找 header 行：某个单元格精确等于 "mcid"（大小写不敏感）
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const row = rows[i] as (unknown | null)[];
    if (!row) continue;
    if (row.some((c) => String(c || "").trim().toLowerCase() === "mcid")) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx === -1) headerRowIdx = 0;

  const headerRow = (rows[headerRowIdx] as (unknown | null)[]) || [];
  const headerText = headerRow.map((c) => String(c || "").trim()).join("|");
  const mcidIdx = headerRow.findIndex((c) => String(c || "").trim().toLowerCase() === "mcid");
  const offset = mcidIdx >= 0 ? mcidIdx : 0;
  // LH 节点格式判定：表头含「下单地区」或「媒体」字样（标准格式是「商家地区」「联盟」）
  const isLhFormat = /下单地区|媒体/.test(headerText);

  const results: NodeMerchantRecord[] = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i] as (unknown | null)[];
    if (!row || row.length === 0) continue;

    if (isLhFormat) {
      // Mcid / MID / 名称 / Website / 下单地区 / EPC / 佣金比例 / 每单佣金；联盟 = mcid 前一列（BU）
      const name = safeStr(row[offset + 2]);
      if (!name || name.length < 2) continue;
      const base = safeStr(row[offset + 4]);
      results.push({
        merchant_name: name,
        mcid: safeStr(row[offset]),
        mid: safeStr(row[offset + 1]),
        affiliate: offset > 0 ? safeStr(row[offset - 1]) : null,
        website: safeStr(row[offset + 3]),
        merchant_base: base ? extractCountryCode(base) : null,
        epc: safeNum(row[offset + 5]),
        commission_cap: null,
        avg_commission_rate: safeNum(row[offset + 6]),
        avg_order_commission: safeNum(row[offset + 7]),
      });
    } else {
      // 标准格式：mcid / MID / 名称 / 联盟 / 网址 / 地区 / EPC / 上限 / 佣金率 / 带单佣金
      const name = safeStr(row[offset + 2]);
      if (!name || name.length < 2) continue;
      const base = safeStr(row[offset + 5]);
      const cap = row[offset + 7];
      results.push({
        merchant_name: name,
        mcid: safeStr(row[offset]),
        mid: safeStr(row[offset + 1]),
        affiliate: safeStr(row[offset + 3]),
        website: safeStr(row[offset + 4]),
        merchant_base: base ? extractCountryCode(base) : null,
        epc: safeNum(row[offset + 6]),
        commission_cap: cap != null ? String(cap).trim() : null,
        avg_commission_rate: safeNum(row[offset + 8]),
        avg_order_commission: safeNum(row[offset + 9]),
      });
    }
  }
  return results;
}

/**
 * 替换式导入某节点的商家清单（只动 source='node' 且 node_code 相同的行）。
 * 同一节点内按 mid（无 mid 用名称小写）去重——同商家多国家行保留首行，国家在专区按 merchant_base 展示。
 * 注意：LH 清单同一 MID 会按国家出现多行，去重后每商家一行；多国家场景以 supported_regions 库内数据为准。
 */
export async function replaceNodeMerchants(nodeCode: string, records: NodeMerchantRecord[]) {
  const seen = new Set<string>();
  const deduped: NodeMerchantRecord[] = [];
  const countryMap = new Map<string, string[]>(); // 去重键 → 该商家清单里出现过的全部国家
  for (const r of records) {
    const key = r.mid ? `mid:${r.mid}` : `name:${r.merchant_name.toLowerCase()}`;
    if (r.merchant_base) {
      const arr = countryMap.get(key) || [];
      if (!arr.includes(r.merchant_base)) arr.push(r.merchant_base);
      countryMap.set(key, arr);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  const deleted = await prisma.merchant_recommendations.updateMany({
    where: { source: NODE_SOURCE, node_code: nodeCode, is_deleted: 0 },
    data: { is_deleted: 1 },
  });

  const ts = todayCST().replace(/-/g, "");
  const batch = `NODE-${nodeCode.toUpperCase()}-${ts}`;

  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < deduped.length; i += BATCH) {
    const chunk = deduped.slice(i, i + BATCH);
    await prisma.merchant_recommendations.createMany({
      data: chunk.map((r) => {
        const key = r.mid ? `mid:${r.mid}` : `name:${r.merchant_name.toLowerCase()}`;
        const countries = countryMap.get(key) || [];
        return {
          merchant_name: r.merchant_name,
          upload_batch: batch,
          source: NODE_SOURCE,
          node_code: nodeCode,
          mcid: r.mcid,
          mid: r.mid,
          affiliate: r.affiliate,
          website: r.website,
          // 多国家合并成 CSV（如 "US,CA"），前端拆开展示
          merchant_base: countries.length > 0 ? countries.join(",") : r.merchant_base,
          epc: r.epc,
          commission_cap: r.commission_cap,
          avg_commission_rate: r.avg_commission_rate,
          avg_order_commission: r.avg_order_commission,
        };
      }),
    });
    inserted += chunk.length;
  }
  return { deleted: deleted.count, inserted, batch, parsed: records.length };
}

/** 距节点天数：node_date（DATE）- 今天（东八区日历日）。节点已过返回负数 */
export function daysUntilNode(nodeDate: Date): number {
  const today = new Date(`${todayCST()}T00:00:00Z`);
  const nd = new Date(`${nodeDate.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((nd.getTime() - today.getTime()) / 86400_000);
}

/**
 * 节点到期提醒（daily-sync 每日 06:00 调用）。
 * 触发条件：enabled 且 0 ≤ 距节点天数 ≤ lead_days，且本届未提醒过
 * （notified_at 为空，或早于"本届提醒窗口开始日"= node_date - lead_days，即上届的残留）。
 * 07 2026-08-25 第 6 问拍板：发全员（非弹窗，type=system）。
 */
export async function checkHolidayNodeReminders(log: (msg: string) => void): Promise<void> {
  const nodes = await prisma.holiday_nodes.findMany({
    where: { enabled: 1, is_deleted: 0 },
  });

  let sent = 0;
  for (const node of nodes) {
    const days = daysUntilNode(node.node_date);
    if (days < 0 || days > node.lead_days) continue;

    // 本届提醒窗口开始时刻（UTC 近似即可，防重发判定只需分辨"本届 vs 上届"）
    const windowStart = new Date(node.node_date.getTime() - node.lead_days * 86400_000);
    if (node.notified_at && node.notified_at >= windowStart) continue; // 本届已发过

    const users = await prisma.users.findMany({
      where: { is_deleted: 0, status: "active" },
      select: { id: true },
    });
    if (users.length === 0) continue;

    const dateStr = node.node_date.toISOString().slice(0, 10);
    const listCount = await prisma.merchant_recommendations.count({
      where: { source: NODE_SOURCE, node_code: node.code, is_deleted: 0 },
    });
    const title = `【节点推荐】${node.name} 还有 ${days} 天（${dateStr}）`;
    const content =
      `海外重大投放节点「${node.name}」临近（${dateStr}${node.countries ? "，主要市场：" + node.countries : ""}）。` +
      (listCount > 0
        ? `选品页「节点推荐」专区已备好 ${listCount} 个该节点历史表现较好的商家清单，另附品类扩展参考，请提前选品、建广告、过审核，留足预热时间。`
        : `请到选品页「节点推荐」专区查看该节点的品类建议，提前选品、建广告、过审核，留足预热时间。`);

    await prisma.notifications.createMany({
      data: users.map((u) => ({
        user_id: u.id,
        type: "system",
        title,
        content,
        metadata: JSON.stringify({ node_code: node.code, node_date: dateStr }),
      })),
    });
    await prisma.holiday_nodes.update({
      where: { id: node.id },
      data: { notified_at: new Date() },
    });
    sent++;
    log(`  [HolidayNode] 📣 ${node.name}（${dateStr}，还有 ${days} 天）已通知 ${users.length} 人`);
  }
  log(`  [HolidayNode] 检查 ${nodes.length} 个节点，本轮发送 ${sent} 个提醒`);
}
