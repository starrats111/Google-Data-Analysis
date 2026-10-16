/**
 * D-370 终版判据回归：把首页脚本真的跑一遍，看列表容器有没有内容。
 *
 * 为什么换成执行式 —— 前面四版判据全都漏过，每一版都是在猜「什么情况会白屏」：
 *   ① 语法可编译                → 漏「渲染器被整段抹掉」（语法合法）
 *   ② + 有没有 DOM 写入代码      → 漏「变量名对不上」（两个文件各自都合法）
 *   ③ + 固定名单比对变量名        → 漏 vitasphere.top（读 blogArticles，不在名单里）
 *   ④ + 正则推导未声明标识符      → 仍漏「先赋值再用」，且误报 null/false/解构名
 * 而 01 的判据从头到尾只有一条：打开首页，有没有内容。
 *
 * 下面每个用例都对应一个线上实际踩到的形态。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { probeRenderedContent } from "../src/lib/site-render-probe";

const A1_HTML = `<!DOCTYPE html><html><body>
  <div class="art-grid" id="article-list"></div>
  <div id="empty" hidden></div>
  <div id="pagination"></div>
</body></html>`;

const GRID_HTML = `<!DOCTYPE html><html><body>
  <div id="articleGrid"></div><div id="searchInput"></div>
</body></html>`;

describe("D-370 执行式判据", () => {
  it("正常站：渲染器填上容器 → rendered", () => {
    const data = 'var posts = [{"id":"1","title":"T1"},{"id":"2","title":"T2"}];';
    const rend = `
      var grid = document.getElementById('article-list');
      grid.innerHTML = posts.map(function(p){ return '<article>' + p.title + '</article>'; }).join('');
    `;
    const r = probeRenderedContent(A1_HTML, [data, rend]);
    assert.equal(r.rendered, true);
    assert.deepEqual(r.filled, ["article-list"]);
    assert.equal(r.itemCount, 2);
  });

  it("变量名对不上（allurahub / vitahaven 形态）→ 报 ReferenceError", () => {
    const data = 'var articlesIndex = [{"id":"1","title":"T"}];';
    const rend = `
      var grid = document.getElementById('article-list');
      grid.innerHTML = articles.map(function(p){ return '<article>'+p.title+'</article>'; }).join('');
    `;
    const r = probeRenderedContent(A1_HTML, [data, rend]);
    assert.equal(r.rendered, false);
    assert.match(String(r.error), /ReferenceError.*articles/);
  });

  it("容器名不符（thegoodsandguard / everydaynes 形态）→ 容器空着", () => {
    // 首页只有 #articleGrid，脚本却填 #article-list
    const data = 'var posts = [{"id":"1","title":"T"}];';
    const rend = `
      var grid = document.getElementById('article-list');
      if (!grid) { /* A1 渲染器就是这样静默 return 的 */ } else {
        grid.innerHTML = posts.map(function(p){ return '<article>'+p.title+'</article>'; }).join('');
      }
    `;
    const r = probeRenderedContent(GRID_HTML, [data, rend]);
    assert.equal(r.rendered, false, "容器名不符必须判白屏");
    assert.ok(r.empty.includes("articleGrid"));
  });

  it("渲染器被整段抹掉（parcelnplate 修复前形态）→ 容器空着", () => {
    const r = probeRenderedContent(A1_HTML, ['var posts = [{"id":"1"}];']);
    assert.equal(r.rendered, false);
  });

  it("先赋值再用也能发现（vitasphere 形态：读 blogArticles）", () => {
    const data = 'var articlesIndex = [{"id":"1","title":"T"}];';
    const rend = `
      var grid = document.getElementById('article-list');
      var filtered = blogArticles;
      grid.innerHTML = filtered.map(function(p){ return '<article>'+p.title+'</article>'; }).join('');
    `;
    const r = probeRenderedContent(A1_HTML, [data, rend]);
    assert.equal(r.rendered, false);
    assert.match(String(r.error), /blogArticles/);
  });

  it("挂在 DOMContentLoaded 上的渲染器也能跑到", () => {
    const data = 'var posts = [{"id":"1","title":"T"}];';
    const rend = `
      document.addEventListener('DOMContentLoaded', function () {
        document.getElementById('article-list').innerHTML = '<article>' + posts[0].title + '</article>';
      });
    `;
    const r = probeRenderedContent(A1_HTML, [data, rend]);
    assert.equal(r.rendered, true, "不触发 DOMContentLoaded 会把好站误判成白屏");
  });

  it("createElement + appendChild 的渲染器也算渲染出来（novanest 形态）", () => {
    const data = 'var POSTS = [{"id":"1","title":"T"}];';
    const rend = `
      var c = document.getElementById('article-list');
      POSTS.forEach(function (p) {
        var card = document.createElement('article');
        card.innerHTML = '<h2>' + p.title + '</h2>';
        c.appendChild(card);
      });
    `;
    const r = probeRenderedContent(A1_HTML, [data, rend]);
    assert.equal(r.rendered, true, "只看 innerHTML 会漏掉用 appendChild 的渲染器");
  });

  it("URLSearchParams 这类浏览器内置不能导致误判", () => {
    const data = 'var posts = [{"id":"1","title":"T"}];';
    const rend = `
      var params = new URLSearchParams(location.search);
      var cat = params.get('cat');
      var list = cat ? posts.filter(function(p){ return p.category === cat; }) : posts;
      document.getElementById('article-list').innerHTML =
        list.map(function(p){ return '<article>'+p.title+'</article>'; }).join('');
    `;
    const r = probeRenderedContent(A1_HTML, [data, rend]);
    assert.equal(r.rendered, true, "沙箱缺内置对象时会把好站全报成白屏（实测踩过）");
  });

  it("数据为空：渲染器跑通但一条没画 → itemCount 为 0", () => {
    const data = "var posts = [];";
    const rend = `
      var grid = document.getElementById('article-list');
      grid.innerHTML = posts.map(function(p){ return '<article></article>'; }).join('');
    `;
    const r = probeRenderedContent(A1_HTML, [data, rend]);
    assert.equal(r.itemCount, 0, "空数据要能和「渲染出内容」区分开");
  });

  it("脚本抛错后，后面的脚本照常试（和浏览器一致）", () => {
    const bad = "throw new Error('boom');";
    const data = 'var posts = [{"id":"1","title":"T"}];';
    const rend = `document.getElementById('article-list').innerHTML = '<article>'+posts[0].title+'</article>';`;
    const r = probeRenderedContent(A1_HTML, [bad, data, rend]);
    assert.equal(r.rendered, true, "一个脚本炸了不该让整站判死");
    assert.match(String(r.error), /boom/);
  });
});
