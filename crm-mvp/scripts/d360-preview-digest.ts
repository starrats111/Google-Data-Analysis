/**
 * D-360 预演脚本：拿线上真实探测结果喂给 formatChannelDigest，肉眼验收日报文案。
 * 只读不连库、不发通知。用法：
 *   npx tsx scripts/d360-preview-digest.ts <probe.tsv> <mccs.tsv>
 * probe.tsv 每行：mcc_id \t http=NNN \t rows=N \t hdr=...
 * mccs.tsv  每行：id \t mcc_id \t name \t is_active \t owner \t active_cid \t enabled_ads \t sheet_url
 */
import { readFileSync, writeFileSync } from "node:fs";
import { classifyProbe, formatChannelDigest, type ChannelHealthRow } from "@/lib/sheet-channel-health";

const [probeFile, mccFile] = process.argv.slice(2);
const meta = new Map<string, { name: string; owner: string; ads: number }>();
for (const l of readFileSync(mccFile, "utf-8").split("\n")) {
  const f = l.replace(/\r$/, "").split("\t");
  if (f.length < 7) continue;
  meta.set(f[1], { name: f[2] === "-" ? "" : f[2], owner: f[4], ads: Number(f[6]) || 0 });
}

const rows: ChannelHealthRow[] = [];
let total = 0;
for (const l of readFileSync(probeFile, "utf-8").split("\n")) {
  const f = l.replace(/\r$/, "").split("\t");
  if (f.length < 4) continue;
  total++;
  const http = f[1].split("=")[1];
  const hdr = f[3].slice(4);
  const state = http !== "200"
    ? classifyProbe({ error: `HTTP ${http}`, wantFirstCol: "customerid" })
    : classifyProbe({ rows: hdr ? [hdr.split(",").map((c) => c.replace(/"/g, "")), ...(Number(f[2].split("=")[1]) > 1 ? [["x"]] : [])] : [], wantFirstCol: "customerid" });
  if (state === "OK") continue;
  const m = meta.get(f[0]);
  rows.push({
    mccId: f[0], mccName: m?.name || null, owner: m?.owner || "?",
    cidList: state, campaignInfo: null, enabledCampaigns: m?.ads ?? 0,
    lastCampaignUpdate: null, lastCostDate: null,
  });
}

const d = formatChannelDigest(rows, total);
writeFileSync("d360-digest-preview.txt", d ? `【${d.title}】\n\n${d.content}\n` : "（无故障，不发日报）", "utf-8");
console.log("wrote d360-digest-preview.txt;", rows.length, "broken of", total);
