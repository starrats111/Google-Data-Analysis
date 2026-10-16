/**
 * D-370：把站点首页的脚本真的跑起来，看容器里到底有没有内容。
 *
 * 为什么必须这样做 —— 前面三版判据都失败了，每次都漏：
 *   v1 语法可编译                 → 漏「渲染器被整段抹掉」（语法合法）
 *   v2 + 有没有 DOM 写入代码       → 漏「变量名对不上」（两个文件各自都合法、渲染器也在）
 *   v3 + 固定候选名单比对变量名     → 漏 vitasphere.top（它读 blogArticles，不在名单里）
 *   v4 + 正则推导未声明标识符       → 仍漏（先赋值再用），且把 null/false/解构名误报成缺失
 *
 * 每一版都是在猜「什么情况下页面会空」。而 01 的判据从头到尾只有一条：
 * **打开首页，有没有内容**。所以这里不再猜，直接执行：
 * 在 Node 的 vm 里给一个最小 DOM 替身，按 <script> 顺序跑完首页加载的脚本，
 * 然后看那些容器元素的 innerHTML 有没有被填上东西。
 *
 * 这个判据与模板无关、与变量名无关、与架构无关 —— 站群里有多少套模板都一样管用。
 */
import { runInNewContext } from "node:vm";

export interface RenderProbeResult {
  /** 是否真的渲染出了内容 */
  rendered: boolean;
  /** 被填上内容的容器 id */
  filled: string[];
  /** 页面里出现过、但始终空着的候选容器 id */
  empty: string[];
  /** 脚本执行时抛出的第一个错误（这往往就是白屏的直接原因） */
  error?: string;
  /** 实际渲染出的卡片/条目数（粗估：容器 innerHTML 里的 <article> 或 class 含 card 的元素数） */
  itemCount: number;
}

/** 一个够用的 DOM 替身：只实现站群这些渲染器会用到的部分 */
interface StubEl {
  id: string;
  tagName: string;
  innerHTML: string;
  textContent: string;
  value: string;
  disabled: boolean;
  className: string;
  classList: { add: () => void; remove: () => void; toggle: () => void; contains: () => boolean };
  style: Record<string, string>;
  children: StubEl[];
  dataset: Record<string, string>;
  hidden: boolean;
  addEventListener: () => void;
  removeEventListener: () => void;
  appendChild: (c: StubEl) => StubEl;
  insertAdjacentHTML: (pos: string, html: string) => void;
  querySelector: () => StubEl | null;
  querySelectorAll: () => StubEl[];
  getAttribute: (k: string) => string | null;
  setAttribute: (k: string, v: string) => void;
  removeAttribute: (k: string) => void;
  closest: () => StubEl | null;
  scrollIntoView: () => void;
  focus: () => void;
  click: () => void;
  remove: () => void;
}

function makeEl(id: string, tagName = "div"): StubEl {
  const attrs: Record<string, string> = {};
  const el: StubEl = {
    id, tagName, innerHTML: "", textContent: "", value: "", disabled: false,
    className: "", hidden: false,
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    style: {}, children: [], dataset: {},
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: (c: StubEl) => {
      el.children.push(c);
      // 真实浏览器里 appendChild 会让父节点"有内容"；这里把子节点的 HTML 累加上去，
      // 否则用 createElement + appendChild 的渲染器（novanest 那套）会被判成没渲染。
      el.innerHTML += c.innerHTML || `<${c.tagName}></${c.tagName}>`;
      return c;
    },
    insertAdjacentHTML: (_pos: string, html: string) => { el.innerHTML += html; },
    querySelector: () => null,
    querySelectorAll: () => [],
    getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    setAttribute: (k: string, v: string) => { attrs[k] = String(v); },
    removeAttribute: (k: string) => { delete attrs[k]; },
    closest: () => null,
    scrollIntoView: () => {},
    focus: () => {},
    click: () => {},
    remove: () => {},
  };
  return el;
}

/** 从 HTML 里抓出所有 id，作为"可能是列表容器"的候选 */
function extractIds(html: string): string[] {
  const ids: string[] = [];
  for (const m of html.matchAll(/\bid=["']([^"']+)["']/g)) ids.push(m[1]);
  return [...new Set(ids)];
}

/**
 * 判断一个 id 看起来像不像"文章列表容器"。
 * 站群里见过的：article-list、articlesGrid、postsContainer、postsGrid、
 * featuredArticles、art-grid、products-container…… 所以按词根匹配而不是枚举。
 */
function looksLikeListContainer(id: string): boolean {
  const s = id.toLowerCase();
  const hasSubject = /(article|post|blog|product|guide|story|item|content|feature)/.test(s);
  const hasShape = /(list|grid|container|wrap|holder|row|feed)/.test(s);
  return hasSubject && hasShape;
}

/**
 * 跑一遍首页脚本，看列表容器有没有被填上内容。
 *
 * @param html 首页 HTML
 * @param scripts 首页按顺序引用的本站脚本内容（含内联脚本）
 */
export function probeRenderedContent(html: string, scripts: string[]): RenderProbeResult {
  const ids = extractIds(html);
  const candidates = ids.filter(looksLikeListContainer);
  // 没有可识别的列表容器时，退而把所有 id 都当候选 —— 宁可宽松，不要漏判
  const watch = candidates.length > 0 ? candidates : ids;

  const store: Record<string, StubEl> = {};
  for (const id of watch) store[id] = makeEl(id);
  // 渲染器还会取一些非容器元素（搜索框、分页按钮），缺了会 return 提前退出
  for (const id of ids) if (!store[id]) store[id] = makeEl(id);

  const readyHandlers: Array<() => void> = [];
  const document = {
    readyState: "loading",
    getElementById: (id: string) => store[id] || null,
    querySelector: (sel: string) => {
      const m = /^#([\w-]+)$/.exec(sel);
      if (m && store[m[1]]) return store[m[1]];
      return null;
    },
    querySelectorAll: () => [] as StubEl[],
    createElement: (tag: string) => makeEl("", tag),
    createDocumentFragment: () => makeEl("", "fragment"),
    addEventListener: (ev: string, fn: () => void) => {
      if (ev === "DOMContentLoaded") readyHandlers.push(fn);
    },
    removeEventListener: () => {},
    body: makeEl("body", "body"),
    head: makeEl("head", "head"),
    documentElement: makeEl("html", "html"),
    cookie: "",
    title: "",
  };

  const windowStub: Record<string, unknown> = {
    document,
    location: { href: "https://example.test/", pathname: "/", search: "", hash: "", host: "example.test" },
    addEventListener: (ev: string, fn: () => void) => {
      if (ev === "DOMContentLoaded" || ev === "load") readyHandlers.push(fn);
    },
    removeEventListener: () => {},
    scrollTo: () => {},
    scrollY: 0,
    pageYOffset: 0,
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
    requestAnimationFrame: (fn: () => void) => { fn(); return 1; },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    fetch: () => Promise.reject(new Error("fetch disabled in probe")),
    console,
  };
  windowStub.window = windowStub;
  windowStub.self = windowStub;
  windowStub.top = windowStub;

  const sandbox: Record<string, unknown> = {
    ...windowStub,
    document,
    window: windowStub,
    console,
    setTimeout: (fn: () => void) => { try { fn(); } catch { /* 忽略定时回调里的错误 */ } return 1; },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    navigator: { userAgent: "d370-probe" },
    history: { replaceState: () => {}, pushState: () => {} },
    alert: () => {},
    // 这些是浏览器里本来就有、vm 沙箱里没有的。缺一个就 ReferenceError，
    // 整段渲染中断、容器空着 —— 会把好站误判成白屏（实测 URLSearchParams
    // 缺失时把 omniportal / universehive 这些已修好的站全报成 BLANK）。
    URLSearchParams,
    URL,
    TextEncoder,
    TextDecoder,
    AbortController,
    Event: class { constructor(public type: string) {} },
    CustomEvent: class { constructor(public type: string) {} },
    Image: class { src = ""; onload: (() => void) | null = null; },
    DOMParser: class {
      parseFromString() { return { body: makeEl("body", "body"), querySelectorAll: () => [] }; }
    },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    performance: { now: () => 0 },
    structuredClone: (v: unknown) => JSON.parse(JSON.stringify(v)),
  };

  let error: string | undefined;
  for (const src of scripts) {
    try {
      runInNewContext(src, sandbox, { timeout: 5000, filename: "site-script.js" });
    } catch (e) {
      if (!error) error = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : String(e).slice(0, 200);
      // 一个脚本炸了，后面的照常试 —— 浏览器也是这样
    }
  }

  // 触发 DOMContentLoaded：大量渲染器把渲染挂在这里
  document.readyState = "complete";
  for (const fn of readyHandlers) {
    try {
      fn();
    } catch (e) {
      if (!error) error = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : String(e).slice(0, 200);
    }
  }

  const filled: string[] = [];
  const empty: string[] = [];
  let itemCount = 0;
  for (const id of watch) {
    const h = store[id]?.innerHTML || "";
    const kids = store[id]?.children.length || 0;
    if (h.trim().length > 0 || kids > 0) {
      filled.push(id);
      itemCount += Math.max(
        (h.match(/<article/gi) || []).length,
        (h.match(/class="[^"]*card/gi) || []).length,
        kids,
      );
    } else {
      empty.push(id);
    }
  }

  return { rendered: filled.length > 0, filled, empty, error, itemCount };
}
