import { NextRequest } from "next/server";
import { withAdmin } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import * as XLSX from "xlsx";
import { parseNodeExcelRows, replaceNodeMerchants } from "@/lib/holiday-nodes";

/**
 * D-278 节点商家清单导入（管理员）
 * POST multipart/form-data：node_code + files（xlsx）
 * 替换式导入：只替换该 node_code 下 source='node' 的行，不碰 excel/sheets/atc 通道。
 * 支持 LH 节点清单 9 列格式与标准推荐清单 10/11 列格式（见 parseNodeExcelRows）。
 * 解析不出任何有效记录时整批拒绝，不落半截数据（D-264 失败路径要求）。
 */
export const POST = withAdmin(async (req: NextRequest) => {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return apiError("请求格式错误，需要 multipart/form-data");
  }

  const nodeCode = String(formData.get("node_code") || "").trim();
  if (!nodeCode) return apiError("缺少 node_code");
  const node = await prisma.holiday_nodes.findUnique({ where: { code: nodeCode } });
  if (!node || node.is_deleted) return apiError(`节点 "${nodeCode}" 不存在，请先在节点管理中创建`);

  const files = formData.getAll("files") as File[];
  if (!files || files.length === 0) return apiError("请至少上传一个 Excel 文件");

  const allRecords = [];
  const parseErrors: string[] = [];
  for (const file of files) {
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
      for (const sheetName of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, defval: null });
        if (rows.length < 2) continue;
        allRecords.push(...parseNodeExcelRows(rows));
      }
    } catch (e) {
      parseErrors.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (allRecords.length === 0) {
    return apiError(`未能解析到任何有效记录，本次不做任何改动。${parseErrors.length > 0 ? "错误：" + parseErrors.join("; ") : ""}`);
  }

  const result = await replaceNodeMerchants(nodeCode, allRecords);
  return apiSuccess(
    { ...result, parseErrors: parseErrors.length > 0 ? parseErrors : undefined },
    `节点「${node.name}」清单导入成功：解析 ${result.parsed} 行，去重后写入 ${result.inserted} 个商家（替换旧清单 ${result.deleted} 条）`,
  );
});
