// 测试运行器：递归收集 tests/**/*.test.ts，经 tsx 装载后交给 Node 内建 test runner。
// 不直接用 shell glob（Windows PowerShell 不展开），也不依赖 Node 21+ 的 --test glob。
import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = join(root, "tests");

function collect(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collect(p));
    else if (name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const files = collect(testsDir);
if (files.length === 0) {
  console.error("tests/ 下没有找到任何 *.test.ts");
  process.exit(1);
}

console.log(`运行 ${files.length} 个测试文件...`);
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...files],
  { cwd: root, stdio: "inherit" },
);
process.exit(result.status ?? 1);
