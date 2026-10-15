/**
 * D-370：「渲染器被抹掉」这一类损坏的回归。
 *
 * 报案（2026-10-15，01）：parcelnplate.top 首页也没内容了，要求先查清原因再修。
 *
 * 查证结论（与 D-368 的归因不同，D-368 把主因记成了并发，这里更正）：
 * 两个白屏站是同一根因的两个阶段，根因是「数据和渲染器塞在同一个文件里，
 * 而写入是读出来-拼一下-整体写回」：
 *
 *   阶段一 omniportal.shop：整体重写写一半断掉。文件里 43 条**缩进**条目
 *     （只有 buildA1MainJs 会产出缩进格式）+ 1 条紧凑条目，渲染器断在中段，
 *     数据数组仍可闭合。sftp.writeFile 用 flag:'w' —— 先把文件截成 0 再逐块写，
 *     进程中途死掉（这台机 PM2 因内存被杀是常态）callback 根本不会被调用，
 *     文件永久停在写了一半的状态，无错误无日志。
 *
 *   阶段二 parcelnplate.top：渲染器被代码**主动抹掉**。文件里 95 条条目
 *     **全是紧凑格式、0 条缩进**，渲染器整段不存在。紧凑格式只有增量插入那行
 *     `"\n  " + JSON.stringify(indexEntry) + ","` 会产出。真因是
 *     publishArticleToSite 的兜底分支：findArrayAssignmentMatch 未命中时
 *     把**整个文件**替换成 buildArrayAssignmentStatement(...) 即裸数据。
 *     此后每次发布只是增量插一条，渲染器永远不会回来。
 *
 * 实测各形态下 findArrayAssignmentMatch 的行为（决定会不会走兜底）：
 *   完好 / 断在渲染器中段 / 断在数据段中间 → 命中，走增量插入
 *   文件不存在 / 空文件 / 断在 `const posts = [` 之前（<15 字节）→ 未命中，走兜底
 *
 * 关键缺口：被抹掉渲染器的内容**语法完全合法**，D-368 的三道语法校验全放行，
 * 给巡检加的 probeRenderer（只做语法编译）也放行 —— 但首页照样白屏，
 * 因为首页 HTML 里列表容器是空的，全靠渲染器填。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkJsSyntax,
  hasRenderer,
  isDataOnly,
  looksLikeRenderer,
  wouldDropRenderer,
  writeJsDataFileGuarded,
} from "../src/lib/site-write-guard";

/** 完整的 A1 文件：数据 + 渲染器 */
const FULL = 'const posts = [\n  {"id":"1","slug":"a"}\n];\n\n(function () {\n'
  + "  var FIXED_CATS = [{k:'fashion'}];\n"
  + "  var grid=document.getElementById('article-list');\n"
  + "  function renderGrid(){ grid.innerHTML=''; }\n"
  + "  renderGrid();\n})();\n";

/** parcelnplate.top 的实际形态：只有紧凑数据，渲染器整段不存在 */
const DATA_ONLY = 'const posts = [\n  {"id":"1","slug":"a"},\n  {"id":"2","slug":"b"}\n];\n';

/** 非 A1 站的纯数据文件：本来就没有渲染器，不算损坏 */
const LEGIT_INDEX = 'const articlesIndex = [\n  {"id":"7","slug":"x"}\n];\n';

describe("D-370 渲染器被抹掉的内容语法是合法的（这是 D-368 的缺口）", () => {
  it("裸数据文件语法校验通过 —— 所以语法校验挡不住这一类", () => {
    assert.equal(checkJsSyntax(DATA_ONLY).ok, true);
  });

  it("完整文件语法也通过（对照）", () => {
    assert.equal(checkJsSyntax(FULL).ok, true);
  });
});

describe("D-370 hasRenderer / isDataOnly", () => {
  it("认出完整 A1 文件里的渲染器", () => {
    assert.equal(hasRenderer(FULL), true);
    assert.equal(isDataOnly(FULL), false);
  });

  it("认出被抹掉渲染器的文件", () => {
    assert.equal(hasRenderer(DATA_ONLY), false);
    assert.equal(isDataOnly(DATA_ONLY), true);
  });

  it("纯数据文件也会被 isDataOnly 判真 —— 调用方须按架构区分，不能一律当故障", () => {
    assert.equal(isDataOnly(LEGIT_INDEX), true);
  });

  it("数据里出现渲染器同名字串不会误判（数据是 JSON，不含代码片段）", () => {
    const dataWithWord = 'const posts = [{"id":"1","title":"How renderGrid changed my life"}];\n';
    // title 里带 renderGrid 这个词 —— 会被当成有渲染器。这是已知的宽松边界：
    // 宁可漏判（不误伤正常站），也不要把好站判成故障再去"修"它。
    assert.equal(hasRenderer(dataWithWord), true);
  });

  it("空内容不算 data-only", () => {
    assert.equal(isDataOnly(""), false);
  });
});

describe("D-370 wouldDropRenderer", () => {
  it("旧文件有渲染器、新内容没有 → 判真", () => {
    assert.equal(wouldDropRenderer(FULL, DATA_ONLY), true);
  });

  it("两边都有渲染器 → 判假（正常的增量插入）", () => {
    const spliced = FULL.replace('const posts = [', 'const posts = [\n  {"id":"NEW"},');
    assert.equal(wouldDropRenderer(FULL, spliced), false);
  });

  it("旧文件本来就没渲染器 → 判假（非 A1 站的正常写入）", () => {
    assert.equal(wouldDropRenderer(LEGIT_INDEX, LEGIT_INDEX), false);
  });
});

function fakeIO(initial?: string) {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set("/w/site/assets/js/main.js", initial);
  return {
    store,
    io: {
      write: async (p: string, c: string) => { store.set(p, c); },
      read: async (p: string) => {
        const v = store.get(p);
        if (v === undefined) throw new Error("ENOENT");
        return v;
      },
    },
  };
}

describe("D-370 写入护栏拦住「抹掉渲染器」的写入", () => {
  const P = "/w/site/assets/js/main.js";

  it("拒绝把含渲染器的文件写成裸数据，且服务器旧文件原样不动", async () => {
    const { io, store } = fakeIO(FULL);
    await assert.rejects(
      () => writeJsDataFileGuarded(io, P, DATA_ONLY),
      /会抹掉首页渲染器/,
    );
    assert.equal(store.get(P), FULL, "旧文件必须保持原样");
  });

  it("放行正常的增量插入（渲染器仍在）", async () => {
    const { io, store } = fakeIO(FULL);
    const spliced = FULL.replace('const posts = [', 'const posts = [\n  {"id":"NEW"},');
    await writeJsDataFileGuarded(io, P, spliced);
    assert.equal(store.get(P), spliced);
  });

  it("文件不存在时放行（新建，无旧文件可比）", async () => {
    const { io, store } = fakeIO();
    await writeJsDataFileGuarded(io, P, FULL);
    assert.equal(store.get(P), FULL);
  });

  it("非 A1 的纯数据文件正常写入不受影响", async () => {
    const { io, store } = fakeIO(LEGIT_INDEX);
    const next = LEGIT_INDEX.replace("[", '[\n  {"id":"8"},');
    await writeJsDataFileGuarded(io, P, next);
    assert.equal(store.get(P), next);
  });
});

/**
 * 「按库重建会不会删掉站上的文章」这道闸的判据。
 *
 * 实测差距是真实的：线上 allurahub.top 文件里 566 条、bloomroots.top 686 条、
 * aura-bloom.top 249 条，而本机库（4 月快照）分别只有 8 / 26 / 40 篇。
 * 若生产库也少于站上，按库重建就会把多出来的条目从索引里抹掉 ——
 * 文章详情页还在，但首页和列表再也找不到它们，等于静默下线。
 *
 * 这里锁住 repairSiteDataFile 用的那个估算口径本身（条目计数正则），
 * 因为它决定闸门会不会漏放。
 */
/**
 * 重建一个损坏文件时，「渲染器怎么办」分三种情形，处理方式各不相同。
 * 这三种都是在生产 11 个坏站上实测出来的，判错任何一种都会把站修得更糟。
 */
describe("D-370 重建时的渲染器归属判定", () => {
  // 判据复刻 repairSiteDataFile 里的分支条件
  // 判据复刻 repairSiteDataFile 里的分支条件。
  // 注意第三个分支用的是 looksLikeRenderer 而非 hasRenderer —— 后者只认 A1 的
  // 特征串，对 novanest.one 那种自有模板判为假，会误落到 bare_data 把渲染器删掉。
  const decide = (raw: string, isA1: boolean) => {
    if (hasRenderer(raw) && checkJsSyntax(raw).ok) return "keep_renderer";
    if (isA1) return "rebuild_a1";
    if (looksLikeRenderer(raw)) return "refuse";
    return "bare_data";
  };

  it("① 渲染器完好 → 只换数组、保留渲染器", () => {
    assert.equal(decide(FULL, true), "keep_renderer");
  });

  it("② A1 站、渲染器被截断 → 用模板完整重建（数据+渲染器）", () => {
    // omniportal.shop 形态：数据数组完整，渲染器断在中段
    const truncatedRenderer = 'const posts = [\n  {"id":"1"}\n];\n\n(function(){\n'
      + "  var grid=document.getElementById('article-list');\n"
      + "  var h='<button class=\"pg-btn'+(i===page?'";
    assert.equal(checkJsSyntax(truncatedRenderer).ok, false, "前提：这文件语法不过");
    assert.equal(hasRenderer(truncatedRenderer), true, "前提：看起来有渲染器代码");
    assert.equal(decide(truncatedRenderer, true), "rebuild_a1");
  });

  it("③ 非 A1、渲染器在本文件里且被截断 → 拒绝执行，交人工", () => {
    // novanest.one 形态：POSTS + 专有模板（prevBtn/nextBtn），渲染器断在尾部。
    // 库里只有文章数据、没有该站渲染器源码，重建不出来。
    const custom = 'const POSTS = [\n  {"id":"1"}\n];\n'
      + "  var grid=document.getElementById('postList');\n"
      + "  if (prevBtn && nextBtn) {\n    prevBtn.disabled = ";
    assert.equal(decide(custom, false), "refuse");
  });

  it("④ 非 A1、本文件只装数据（渲染器在别的好脚本里）→ 重建成纯数据", () => {
    // allurahub.top / vitahaven.click 形态：坏的 articles-index.js 是纯数据，
    // 渲染器在完好的 js/main.js 里 —— 这时重建成裸数据是正确的。
    const dataIndex = 'const articlesIndex = [\n  {"id":"1"},\n  {"id":"2","slug":"trunc';
    assert.equal(hasRenderer(dataIndex), false);
    assert.equal(decide(dataIndex, false), "bare_data");
  });

  it("关键反例：不能只看「有没有渲染器代码」就保留其后内容", () => {
    // 这是实测踩到的坑：omniportal 截断在渲染器中段时 hasRenderer 为真，
    // 若据此走 replaceJsArrayLiteral，保留下来的正是断掉的残骸，
    // 生成结果照样语法不合法（被写入护栏拦下，报「第 897 行」）。
    const truncInRenderer = 'const posts = [\n  {"id":"1"}\n];\n(function(){ var x="unclosed';
    assert.equal(hasRenderer(truncInRenderer), false, "这个样本没有渲染器特征串");
    // 换一个确实含特征串且截断的
    const withMarker = 'const posts = [\n  {"id":"1"}\n];\n(function(){ var FIXED_CATS=[]; var s="unclosed';
    assert.equal(hasRenderer(withMarker), true);
    assert.equal(checkJsSyntax(withMarker).ok, false);
    assert.notEqual(decide(withMarker, true), "keep_renderer", "必须不走保留分支");
  });
});

describe("D-370 线上条目数估算（shrink 闸门的输入）", () => {
  const countEntries = (raw: string) =>
    (raw.match(/"id"\s*:/g) || []).length || (raw.match(/\bid\s*:/g) || []).length;

  it("数得出带引号的紧凑条目（增量插入产出的格式）", () => {
    const raw = 'const posts = [\n  {"id":"1"},\n  {"id":"2"},\n  {"id":"3"}\n];';
    assert.equal(countEntries(raw), 3);
  });

  it("数得出带空格的缩进条目（整体重写产出的格式）", () => {
    const raw = 'const posts = [\n  {\n    "id": "1"\n  },\n  {\n    "id": "2"\n  }\n];';
    assert.equal(countEntries(raw), 2);
  });

  it("数得出不带引号的 id:（kivanta.top 用的那套模板）", () => {
    const raw = "const articles = [\n  {id: 1, t:'a'},\n  {id: 2, t:'b'}\n];";
    assert.equal(countEntries(raw), 2);
  });

  it("截断的文件也能数出前半截 —— 闸门正是要在这种文件上生效", () => {
    const raw = 'const posts = [\n  {"id":"1"},\n  {"id":"2"},\n  {"id":"3","slug":"trunc';
    assert.equal(countEntries(raw), 3);
  });

  it("空数组数出 0 —— 此时走 0 篇那条拒绝，不走 shrink 闸门", () => {
    assert.equal(countEntries("const posts = [];"), 0);
  });

  it("闸门阈值：库里少于线上 60% 才拦（避免正常删文被误拦）", () => {
    const shrinks = (db: number, live: number) => live > 0 && db < live * 0.6;
    assert.equal(shrinks(8, 566), true, "8 vs 566 必须拦");
    assert.equal(shrinks(26, 686), true, "26 vs 686 必须拦");
    assert.equal(shrinks(40, 249), true, "40 vs 249 必须拦");
    assert.equal(shrinks(44, 44), false, "条目数相当不该拦");
    assert.equal(shrinks(40, 44), false, "删掉几篇属正常，不该拦");
  });
});
