/**
 * D-368：站点数据文件写入护栏（按站点互斥 + 写前/写后语法校验）回归。
 *
 * 报案现象（2026-10-15，徐亮转员工微信）：「https://omniportal.shop/ 这个网站首页没有内容了」
 * 同时问「https://universehive.shop/ 无法访问，查域名是不是到期了」。
 * 查证：universehive.shop 确实已到期（2026-08-07 过期 → pending delete + redemption period，
 * 属 D-319 已拍板不续费、已迁 universehive.top 的那个站）；
 * 但 omniportal.shop 域名有效期到 2027-04-24，白屏是另一回事 ——
 * 源站上的 assets/js/main.js 是个语法损坏的文件，结尾断在字符串中间：
 *     for(var i=1;i<=pages;i++)h+='<button class="pg-btn'+(i===page?'
 * 两次取同一 md5、cf-cache-status: MISS 下仍是 42356 字节，排除传输与缓存问题。
 * 那个文件是首页唯一的渲染器（文章列表/首图/分类/分页），脚本不执行首页即空白。
 *
 * 公网抽查 19 个站，6 个损坏（omniportal.shop / kivanta.top / novanest.one /
 * keymint.co / vitasphere.top / bloomroots.top），文件时间散在 09-05 到 10-15 凌晨。
 *
 * 本测试锁住三条判据：
 *   ① 截断 / 错位重叠的内容必须被语法校验挡住，不许写出去；
 *   ② 写后回读不一致（被截断、被并发覆盖）必须抛错，不许静默成功；
 *   ③ 同一站点的并发写被串成队列，互不交错；不同站点仍可并行。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkJsSyntax,
  isJsDataFile,
  withSiteLock,
  writeJsDataFileGuarded,
} from "../src/lib/site-write-guard";

// 线上真实残骸（omniportal.shop 2026-10-15 抓的文件尾部，原样截断）
const TRUNCATED_TAIL =
  "const posts = [{\"id\":\"5693\",\"title\":\"ok\"}];\n" +
  "(function(){\n" +
  "  var pages=3,page=1,h='';\n" +
  "  var h='<button class=\"pg-btn\" data-p=\"'+(page-1)+'\">Prev</button>';\n" +
  "  for(var i=1;i<=pages;i++)h+='<button class=\"pg-btn'+(i===page?'";

// vitasphere.top 的错位重叠残骸：两段内容写串了
const OVERLAPPED =
  "const posts = [{\"id\":\"1\"}];\n" +
  "pg.querySelectorAll('[data-p]').forEach(function(b){b.addEventListener('click'," +
  "function(){var x=+b.getAttribute('daventListener('click',function(){var x=+b.getAttribute('da";

const HEALTHY = "const posts = [{\"id\":\"1\",\"title\":\"hello\"}];\n(function(){var a=1;})();\n";

describe("D-368 checkJsSyntax", () => {
  it("放行语法完好的数据文件", () => {
    assert.equal(checkJsSyntax(HEALTHY).ok, true);
  });

  it("挡住线上那条截断残骸（字符串未闭合）", () => {
    const r = checkJsSyntax(TRUNCATED_TAIL);
    assert.equal(r.ok, false);
    assert.ok(r.error && r.error.length > 0, "应带上报错信息");
  });

  it("挡住并发写造成的错位重叠残骸", () => {
    assert.equal(checkJsSyntax(OVERLAPPED).ok, false);
  });

  it("只编译不执行 —— 浏览器 API 不存在也算语法合法", () => {
    // 站点 main.js 全是 document/window/IntersectionObserver，执行必报 ReferenceError，
    // 但它们语法上完全合法，不能被判成损坏
    const browserJs =
      "var io=new IntersectionObserver(function(){});" +
      "document.getElementById('article-list').innerHTML='x';" +
      "window.scrollTo({top:0});";
    assert.equal(checkJsSyntax(browserJs).ok, true);
  });

  it("空内容算合法（空文件是另一类问题，不由语法校验负责）", () => {
    assert.equal(checkJsSyntax("").ok, true);
  });
});

describe("D-368 isJsDataFile", () => {
  it("识别 .js，忽略查询串", () => {
    assert.equal(isJsDataFile("assets/js/main.js"), true);
    assert.equal(isJsDataFile("assets/js/main.js?v=1788612864"), true);
  });

  it("HTML / JSON 不走 JS 校验", () => {
    assert.equal(isJsDataFile("index.html"), false);
    assert.equal(isJsDataFile("js/articles/5693.json"), false);
  });
});

/** 内存假 SFTP，可注入「写入时被截断」等故障 */
function fakeIO(opts: { truncateTo?: number; failRead?: boolean } = {}) {
  const store = new Map<string, string>();
  return {
    store,
    io: {
      write: async (p: string, c: string) => {
        store.set(p, opts.truncateTo !== undefined ? c.slice(0, opts.truncateTo) : c);
      },
      read: async (p: string) => {
        if (opts.failRead) throw new Error("connection reset");
        const v = store.get(p);
        if (v === undefined) throw new Error("ENOENT");
        return v;
      },
    },
  };
}

describe("D-368 writeJsDataFileGuarded", () => {
  it("正常内容写入并通过回读校验", async () => {
    const { io, store } = fakeIO();
    await writeJsDataFileGuarded(io, "/w/site/assets/js/main.js", HEALTHY);
    assert.equal(store.get("/w/site/assets/js/main.js"), HEALTHY);
  });

  it("拼坏的内容根本不往服务器送 —— 旧文件保持原样", async () => {
    const { io, store } = fakeIO();
    store.set("/w/site/assets/js/main.js", HEALTHY); // 服务器上已有好文件
    await assert.rejects(
      () => writeJsDataFileGuarded(io, "/w/site/assets/js/main.js", TRUNCATED_TAIL),
      /拒绝写入/,
    );
    assert.equal(
      store.get("/w/site/assets/js/main.js"),
      HEALTHY,
      "写前校验失败时绝不能动服务器上的旧文件",
    );
  });

  it("写入被截断时抛错，不静默报成功", async () => {
    const { io } = fakeIO({ truncateTo: 20 });
    await assert.rejects(
      () => writeJsDataFileGuarded(io, "/w/site/assets/js/main.js", HEALTHY),
      /回读长度不符/,
    );
  });

  it("回读失败时抛错", async () => {
    const { io } = fakeIO({ failRead: true });
    await assert.rejects(
      () => writeJsDataFileGuarded(io, "/w/site/assets/js/main.js", HEALTHY),
      /无法回读校验/,
    );
  });
});

describe("D-368 withSiteLock", () => {
  it("同一站点的并发写被串成队列，不交错", async () => {
    const trace: string[] = [];
    const task = (tag: string) => async () => {
      trace.push(`${tag}:start`);
      await new Promise((r) => setTimeout(r, 15));
      trace.push(`${tag}:end`);
    };

    await Promise.all([
      withSiteLock("/www/omniportal.shop", task("A")),
      withSiteLock("/www/omniportal.shop", task("B")),
      withSiteLock("/www/omniportal.shop", task("C")),
    ]);

    // 不交错意味着每个 start 后面紧跟自己的 end
    assert.deepEqual(trace, [
      "A:start", "A:end",
      "B:start", "B:end",
      "C:start", "C:end",
    ]);
  });

  it("不同站点并行，互不排队", async () => {
    const started: string[] = [];
    const task = (tag: string) => async () => {
      started.push(tag);
      await new Promise((r) => setTimeout(r, 20));
    };
    const t0 = Date.now();
    await Promise.all([
      withSiteLock("/www/site-a.top", task("a")),
      withSiteLock("/www/site-b.top", task("b")),
    ]);
    const elapsed = Date.now() - t0;
    assert.equal(started.length, 2);
    assert.ok(elapsed < 60, `两个站点应并行（实际 ${elapsed}ms，串行会 ≥40ms）`);
  });

  it("前一个任务抛错不传染后面排队的任务", async () => {
    const siteRoot = "/www/failure-isolation.top";
    const first = withSiteLock(siteRoot, async () => { throw new Error("boom"); });
    const second = withSiteLock(siteRoot, async () => "ok");

    await assert.rejects(() => first, /boom/);
    assert.equal(await second, "ok");
  });

  it("路径尾部斜杠不会被当成两个不同站点", async () => {
    const trace: string[] = [];
    const task = (tag: string) => async () => {
      trace.push(`${tag}:start`);
      await new Promise((r) => setTimeout(r, 15));
      trace.push(`${tag}:end`);
    };
    await Promise.all([
      withSiteLock("/www/trailing.top", task("A")),
      withSiteLock("/www/trailing.top/", task("B")),
    ]);
    assert.deepEqual(trace, ["A:start", "A:end", "B:start", "B:end"]);
  });
});
