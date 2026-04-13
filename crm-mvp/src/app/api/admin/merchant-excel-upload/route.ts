import { NextRequest } from "next/server";
import { getAdminFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import * as XLSX from "xlsx";

/**
 * POST /api/admin/merchant-excel-upload
 * 接收多个推荐商家 Excel 文件，解析后全量替换 source=excel 的记录
 *
 * 表格通用格式（前2行为标题）：
 * 行1: 标题说明（跳过）
 * 行2: 列头 —— mcid / MID / 广告主名称 / 联盟 / 网址 / 商家地区 / EPC / 佣金上限 / 平均佣金率 / 平均带单佣金
 *      CZ新平台多一列 BU（第1列，忽略）
 */
export async function POST(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return apiError("请求格式错误，需要 multipart/form-data");
  }

  const files = formData.getAll("files") as File[];
  if (!files || files.length === 0) return apiError("请至少上传一个 Excel 文件");

  const allRecords: ParsedRecord[] = [];
  const parseErrors: string[] = [];

  for (const file of files) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const buf = Buffer.from(arrayBuffer);
      const wb = XLSX.read(buf, { type: "buffer", cellDates: true });

      for (const sheetName of wb.SheetNames) {
        const ws = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });
        if (rows.length < 3) continue;

        const records = parseExcelRows(rows, file.name, sheetName);
        allRecords.push(...records);
      }
    } catch (e: any) {
      parseErrors.push(`${file.name}: ${e?.message || String(e)}`);
    }
  }

  if (allRecords.length === 0) {
    return apiError(`未能解析到任何有效记录。${parseErrors.length > 0 ? "错误：" + parseErrors.join("; ") : ""}`);
  }

  // 软删除所有现有 source=excel 的推荐记录
  const deleted = await prisma.merchant_recommendations.updateMany({
    where: { source: "excel", is_deleted: 0 },
    data: { is_deleted: 1 },
  });

  // 生成批次标识，格式: EXCEL-YYYYMM
  const now = new Date();
  const batchTs = `EXCEL-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;

  // 去重（按 merchant_name 去重，保留第一条）
  const seen = new Set<string>();
  const deduped = allRecords.filter((r) => {
    const key = r.merchant_name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 批量插入
  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < deduped.length; i += BATCH) {
    const chunk = deduped.slice(i, i + BATCH);
    await prisma.merchant_recommendations.createMany({
      data: chunk.map((r) => ({
        merchant_name: r.merchant_name,
        upload_batch: batchTs,
        source: "excel",
        mcid: r.mcid || null,
        mid: r.mid || null,
        affiliate: r.affiliate || null,
        website: r.website || null,
        merchant_base: r.merchant_base || null,
        epc: r.epc ?? null,
        commission_cap: r.commission_cap || null,
        avg_commission_rate: r.avg_commission_rate ?? null,
        avg_order_commission: r.avg_order_commission ?? null,
        // Google Sheets 字段留空
        roi_reference: null,
        commission_info: null,
        settlement_info: null,
        remark: null,
        share_time: null,
      })),
    });
    inserted += chunk.length;
  }

  // 更新匹配到的 user_merchants 推荐状态
  const recommendedNames = deduped.map((r) => r.merchant_name);
  let marked = 0;
  if (recommendedNames.length > 0) {
    // 分批匹配，避免 IN 子句过长
    for (let i = 0; i < recommendedNames.length; i += 500) {
      const batch = recommendedNames.slice(i, i + 500);
      const result = await prisma.user_merchants.updateMany({
        where: {
          is_deleted: 0,
          merchant_name: { in: batch },
          recommendation_status: { not: "recommended" },
        },
        data: {
          recommendation_status: "recommended",
          recommendation_time: now,
        },
      });
      marked += result.count;
    }
  }

  return apiSuccess({
    parsed: allRecords.length,
    deduplicated: deduped.length,
    deleted: deleted.count,
    inserted,
    marked,
    batch: batchTs,
    parseErrors: parseErrors.length > 0 ? parseErrors : undefined,
  }, `Excel 导入成功：共解析 ${allRecords.length} 条，去重后写入 ${inserted} 条，匹配标记 ${marked} 个商家`);
}

interface ParsedRecord {
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

/**
 * 解析 Excel 行数据
 * 支持两种格式：
 * - 标准格式（10列）: mcid / MID / Name / Affiliate / Website / Base / EPC / Cap / Rate / OrderCommission
 * - CZ 格式（11列）: BU / mcid / MID / Name / Affiliate / Website / Base / EPC / Cap / Rate / OrderCommission
 */
function parseExcelRows(rows: unknown[][], fileName: string, sheetName: string): ParsedRecord[] {
  // 找 header 行：找到某个单元格精确等于 "mcid"（大小写不敏感）的那一行
  // 用精确匹配而非包含匹配，避免标题行 "Recommended Advertiser List" 中的 "advertiser" 干扰
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const row = rows[i] as (unknown | null)[];
    const hasMcid = row.some((c) => String(c || "").trim().toLowerCase() === "mcid");
    if (hasMcid) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx === -1) headerRowIdx = 1; // 默认第2行为 header

  const headerRow = rows[headerRowIdx] as (unknown | null)[];
  // BU 列在 CZ 格式中固定为第一列，精确匹配 "BU"
  const hasBU = String(headerRow[0] || "").trim().toUpperCase() === "BU";

  // 列索引偏移（CZ 格式有 BU 列在最前面）
  const offset = hasBU ? 1 : 0;

  const results: ParsedRecord[] = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i] as (unknown | null)[];
    if (!row || row.length === 0) continue;

    const mcid = safeStr(row[offset]);       // col 0: mcid
    const mid = safeStr(row[offset + 1]);    // col 1: MID
    const name = safeStr(row[offset + 2]);   // col 2: 广告主名称
    const affiliate = safeStr(row[offset + 3]); // col 3: 联盟
    const website = safeStr(row[offset + 4]);   // col 4: 网址
    const base = safeStr(row[offset + 5]);      // col 5: 商家地区
    const epcRaw = row[offset + 6];             // col 6: EPC
    const capRaw = row[offset + 7];             // col 7: 佣金上限
    const rateRaw = row[offset + 8];            // col 8: 平均佣金率
    const orderRaw = row[offset + 9];           // col 9: 平均带单佣金

    if (!name || name.length < 2) continue; // 跳过空行

    results.push({
      merchant_name: name.trim(),
      mcid: mcid || null,
      mid: mid ? String(mid).trim() : null,
      affiliate: affiliate || null,
      website: website || null,
      merchant_base: base ? extractCountryCode(base) : null,
      epc: safeNum(epcRaw),
      commission_cap: capRaw != null ? String(capRaw).trim() : null,
      avg_commission_rate: safeNum(rateRaw),
      avg_order_commission: safeNum(orderRaw),
    });
  }

  console.error(`[ExcelUpload] ${fileName}/${sheetName}: parsed ${results.length} records (hasBU=${hasBU})`);
  return results;
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

/** 提取国家代码，如 "美国(US)" → "US"，"英国(GB)" → "GB" */
function extractCountryCode(base: string): string {
  const match = base.match(/\(([A-Z]{2,3})\)/);
  return match ? match[1] : base.trim();
}
