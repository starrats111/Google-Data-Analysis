import { NextRequest } from "next/server";
import { getAdminFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import * as XLSX from "xlsx";
import { parseSettlementExcelRows, type SettlementRecord } from "@/lib/merchant-settlement";

/**
 * POST /api/admin/merchant-settlement-upload
 * D-374：接收丰度/邮政群里定期分享的商家结算率 Excel，解析后全量替换现有记录
 *
 * 表格格式（第1行为表头）：
 * 平台 / 商家名称 / MID / 订单数 / 总佣金($) / 结算率 / ... / 拒付率 / 拒付($) / 已确认($) / 已支付($) / 待审核($) / 订单金额($)
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

  const allRecords: SettlementRecord[] = [];
  const parseErrors: string[] = [];

  for (const file of files) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const buf = Buffer.from(arrayBuffer);
      const wb = XLSX.read(buf, { type: "buffer", cellDates: true });

      for (const sheetName of wb.SheetNames) {
        const ws = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });
        if (rows.length < 2) continue;

        const records = parseSettlementExcelRows(rows);
        allRecords.push(...records);
      }
    } catch (e: any) {
      parseErrors.push(`${file.name}: ${e?.message || String(e)}`);
    }
  }

  if (allRecords.length === 0) {
    return apiError(`未能解析到任何有效记录（结算率=0 或空的行已被跳过）。${parseErrors.length > 0 ? "错误：" + parseErrors.join("; ") : ""}`);
  }

  // 去重（按 平台+商家名+MID 去重，保留第一条）
  const seen = new Set<string>();
  const deduped = allRecords.filter((r) => {
    const key = `${r.platform}:${r.merchant_name.toLowerCase()}:${r.mid || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 软删除所有现有记录（全量替换）
  const deleted = await prisma.merchant_settlement_rates.updateMany({
    where: { is_deleted: 0 },
    data: { is_deleted: 1 },
  });

  const now = new Date();
  const batch = `SETTLE-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;

  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < deduped.length; i += BATCH) {
    const chunk = deduped.slice(i, i + BATCH);
    await prisma.merchant_settlement_rates.createMany({
      data: chunk.map((r) => ({
        platform: r.platform,
        merchant_name: r.merchant_name,
        mid: r.mid,
        order_count: r.order_count,
        total_commission: r.total_commission,
        settlement_rate: r.settlement_rate,
        chargeback_rate: r.chargeback_rate,
        chargeback_amount: r.chargeback_amount,
        confirmed_amount: r.confirmed_amount,
        paid_amount: r.paid_amount,
        pending_amount: r.pending_amount,
        order_amount: r.order_amount,
        remark: r.remark,
        upload_batch: batch,
      })),
    });
    inserted += chunk.length;
  }

  return apiSuccess({
    parsed: allRecords.length,
    deduplicated: deduped.length,
    deleted: deleted.count,
    inserted,
    batch,
    parseErrors: parseErrors.length > 0 ? parseErrors : undefined,
  }, `导入成功：共解析 ${allRecords.length} 条，去重后写入 ${inserted} 条（原有 ${deleted.count} 条已替换）`);
}
