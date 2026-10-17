/**
 * D-370：adaptEntryToHomepageSchema 新增的 categories 数组 schema 分支。
 *
 * omniluxe.top 的根因链：publishArticleToSite 往主数据文件插入新文章时，
 * 原来直接用 CRM 标准字段（indexEntry），从未按该站现有条目的字段风格
 * 适配——这一点和 adaptEntryToHomepageSchema 原有的「url schema」分支
 * 要解决的问题是同一类，只是 omniluxe.top 的原生字段形态不同
 * （categories 数组 + articleUrl + displayDate，不是 url + catKey）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adaptEntryToHomepageSchema } from "../src/lib/remote-publisher";

const CRM_INDEX_ENTRY = {
  id: "9001",
  slug: "new-post",
  title: "New Post",
  category: "travel",
  date: "2026-10-17",
  dateISO: "2026-10-17",
  dateLabel: "Oct 17, 2026",
  readTime: "5 min read",
  excerpt: "some excerpt",
  image: "/images/articles/9001_0.webp",
  heroImage: "/images/articles/9001_0.webp",
  detailUrl: "post-new-post",
  tags: ["travel"],
};

describe("D-370 adaptEntryToHomepageSchema：categories 数组 schema（omniluxe.top 形态）", () => {
  it("现有条目用 categories 数组 + articleUrl 时，适配成同一套字段", () => {
    const existing = [
      { slug: "old", title: "Old", categories: ["Clothing & Accessories"], date: "2025-01-18", displayDate: "January 18, 2025", excerpt: "e", image: "/i.png", articleUrl: "articles/old.html" },
    ];
    const adapted = adaptEntryToHomepageSchema(CRM_INDEX_ENTRY, existing);
    assert.ok(Array.isArray(adapted.categories), "该站用数组字段，不是字符串");
    assert.equal(typeof adapted.articleUrl, "string");
    assert.equal(adapted.category, undefined, "不该混入标准字段，否则下次又对不上");
    assert.equal(adapted.detailUrl, undefined);
  });

  it("category 值被转成人类可读标签，和该站现有条目风格一致", () => {
    const existing = [
      { slug: "old", title: "Old", categories: ["Travel & Accommodation"], date: "2025-01-01", displayDate: "January 1, 2025", excerpt: "e", image: "/i.png", articleUrl: "articles/old.html" },
    ];
    const adapted = adaptEntryToHomepageSchema(CRM_INDEX_ENTRY, existing);
    assert.deepEqual(adapted.categories, ["Travel & Accommodation"]);
  });

  it("articleUrl 按该站路径风格生成（/slug/ 形式）", () => {
    const existing = [
      { slug: "old", title: "Old", categories: ["Travel"], date: "2025-01-01", displayDate: "January 1, 2025", excerpt: "e", image: "/i.png", articleUrl: "articles/old.html" },
    ];
    const adapted = adaptEntryToHomepageSchema(CRM_INDEX_ENTRY, existing);
    assert.equal(adapted.articleUrl, "/post-new-post/");
  });

  it("不该误伤：现有条目是标准 CRM schema 时不做任何改动", () => {
    const existing = [
      { id: "1", slug: "old", title: "Old", category: "travel", detailUrl: "post-old", dateISO: "2025-01-01", dateLabel: "Jan 1, 2025", image: "/i.png", heroImage: "/i.png", excerpt: "e", readTime: "1 min read", tags: ["travel"] },
    ];
    const adapted = adaptEntryToHomepageSchema(CRM_INDEX_ENTRY, existing);
    assert.equal(adapted, CRM_INDEX_ENTRY, "标准 schema 不该被改动，原样返回");
  });

  it("不该误伤：url schema（原有分支）依然按原逻辑走，不被新分支抢走", () => {
    const existing = [
      { id: "1", slug: "old", title: "Old", url: "/post-old/", catKey: "travel" },
    ];
    const adapted = adaptEntryToHomepageSchema(CRM_INDEX_ENTRY, existing);
    assert.equal(typeof adapted.url, "string", "该走 url schema 分支");
    assert.equal(adapted.categories, undefined, "不该误判成 categories 数组 schema");
  });
});
