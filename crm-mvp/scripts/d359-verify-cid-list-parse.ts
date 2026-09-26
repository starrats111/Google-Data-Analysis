/**
 * D-359 验证脚本：走真实取数路径（readSheetCsv → parseCidListRows）核对 CID_List 解析。
 *
 * 只读，不连库、不写库。用法：
 *   npx tsx scripts/d359-verify-cid-list-parse.ts <sheetUrl 或 sheetId> [更多…]
 *
 * 输出每张表：吞行数（countAbsorbedHeaderRows，修好后应恒为 0）、解析行数、
 * 以及 Status 列的分布。修复前后对比即可看出被吞掉的那几十行是否回到数据区。
 */
import { readSheetCsv, extractSheetId } from "@/lib/sheet-sync";
import { parseCidListRows, countAbsorbedHeaderRows } from "@/lib/cid-list-sheet-sync";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("用法: npx tsx scripts/d359-verify-cid-list-parse.ts <sheetUrl|sheetId> ...");
    process.exit(1);
  }

  for (const arg of args) {
    const sid = arg.includes("/d/") ? extractSheetId(arg) : arg;
    if (!sid) { console.log(`${arg}: 取不出 spreadsheetId，跳过`); continue; }

    let rows: string[][];
    try {
      rows = await readSheetCsv(sid, "CID_List");
    } catch (e) {
      console.log(`${sid}: 拉取失败 ${e instanceof Error ? e.message.slice(0, 100) : e}`);
      continue;
    }

    const absorbed = countAbsorbedHeaderRows(rows);
    const parsed = parseCidListRows(rows);
    const dist: Record<string, number> = {};
    for (const r of parsed ?? []) dist[r.google_status ?? "(空)"] = (dist[r.google_status ?? "(空)"] ?? 0) + 1;

    console.log(
      `${sid}: 原始 ${rows.length} 行 / 解析 ${parsed ? parsed.length : "null（表头不符）"} 行` +
      ` / 吞行 ${absorbed}${absorbed > 0 ? " ⚠️ 解析结果缺行，本轮不该判取消" : ""}` +
      ` / 状态 ${JSON.stringify(dist)}`,
    );
  }
}

main().then(() => process.exit(0));
