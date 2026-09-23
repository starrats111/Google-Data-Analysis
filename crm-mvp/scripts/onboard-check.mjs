#!/usr/bin/env node
/**
 * 新同事加入自检：一条命令报出环境还缺什么。
 * 用法：node scripts/onboard-check.mjs
 * 只读检查，不写任何文件、不连生产库、不打印密钥值。
 */
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const ok = (s) => `  [OK]   ${s}`;
const bad = (s) => `  [缺]   ${s}`;
const warn = (s) => `  [注意] ${s}`;
let fail = 0;

const line = (t) => console.log(`\n== ${t} ==`);

// 1. 工具链
line("工具链");
const want = { node: "24", npm: "11" };
const nodeMajor = process.versions.node.split(".")[0];
console.log(nodeMajor === want.node ? ok(`Node v${process.versions.node}`)
  : warn(`Node v${process.versions.node}，本机基准是 v24.x（不一定出错，但 prisma/next 版本敏感）`));
try {
  const npmV = execSync("npm -v", { encoding: "utf8" }).trim();
  console.log(npmV.split(".")[0] === want.npm ? ok(`npm ${npmV}`) : warn(`npm ${npmV}，基准 11.x`));
} catch { console.log(bad("npm 不可用")); fail++; }

// 2. .env 必需键（只看键名，不打印值）
line(".env 键完整性");
const envPath = join(process.cwd(), ".env");
const REQUIRED = [
  "DATABASE_URL", "SHADOW_DATABASE_URL", "DB_HOST", "DB_PORT", "DB_USER",
  "DB_PASSWORD", "DB_NAME", "JWT_SECRET", "GOOGLE_ADS_DEVELOPER_TOKEN", "BACKEND_API_URL",
];
// 这 4 个连 .env.example 都没有，最容易漏
const NOT_IN_EXAMPLE = ["DATABASE_URL", "SHADOW_DATABASE_URL", "GOOGLE_ADS_DEVELOPER_TOKEN", "BACKEND_API_URL"];
if (!existsSync(envPath)) {
  console.log(bad(".env 不存在。照 .env.example 建，但注意它缺 4 个键：" + NOT_IN_EXAMPLE.join(", ")));
  fail++;
} else {
  const keys = new Set(
    readFileSync(envPath, "utf8").split(/\r?\n/)
      .map((l) => l.match(/^([A-Za-z0-9_]+)\s*=/)?.[1]).filter(Boolean)
  );
  for (const k of REQUIRED) {
    if (keys.has(k)) console.log(ok(k));
    else { console.log(bad(k + (NOT_IN_EXAMPLE.includes(k) ? "（.env.example 里没有，必须找 01 要）" : ""))); fail++; }
  }
}

// 3. SSH 私钥 4 把
line("SSH 私钥");
const KEYS = [
  ["xlx0310.pem", "CRM 43.156.142.141"],
  ["yangma0612.pem", "Hermes 43.165.170.242"],
  ["xc0224.pem", "kylink 43.106.49.28 + kyads 216.67.230.8"],
  ["id_ed25519", "通用"],
];
for (const [f, use] of KEYS) {
  const hit = [join(homedir(), ".ssh", f), join(homedir(), f)].find(existsSync);
  console.log(hit ? ok(`${f} — ${use}`) : bad(`${f} — ${use}`));
  if (!hit) fail++;
}

// 4. 机密目录与记忆库
line("机密目录 / 记忆库");
const infra = join(homedir(), ".infra");
const INFRA_FILES = ["服务器总账.md", "部署总览.md", "三系统架构与集成.md", "kyads-sa.json", "crm-prod-db.env", "crm-proxies.tsv"];
if (!existsSync(infra)) { console.log(bad("~/.infra 整个目录不存在（最关键的一份，找 01 线下要）")); fail++; }
else for (const f of INFRA_FILES) {
  const e = existsSync(join(infra, f));
  console.log(e ? ok(".infra/" + f) : bad(".infra/" + f));
  if (!e) fail++;
}

// 5. 随仓库分发的工作规则
line("工作规则（应随 clone 到手）");
const RULES = ["data-channel", "data-verification", "infra-registry", "pre-work-confirmation", "seo-article-style", "deployment", "data-integrity", "base"];
for (const r of RULES) {
  const p = join(process.cwd(), "..", ".cursor", "rules", `${r}.mdc`);
  const e = existsSync(p);
  console.log(e ? ok(`${r}.mdc`) : bad(`${r}.mdc（应在仓库里，缺了说明 clone 不全）`));
  if (!e) fail++;
}

// 6. 依赖
line("依赖");
console.log(existsSync(join(process.cwd(), "node_modules")) ? ok("node_modules 已安装") : bad("未 npm install"));

console.log(
  fail === 0
    ? "\n结论：环境齐了。下一步读 ../02_同事加入清单.md 第四节「当面必须讲的三件事」。\n"
    : `\n结论：还缺 ${fail} 项（上面标 [缺] 的）。机密类只能找 01 线下拿，别走 IM。\n`
);
process.exit(fail === 0 ? 0 : 1);
