/**
 * D-370：quiblo.top 首页「精选文章」区块一直空着——不是白屏类故障。
 *
 * 真因：quiblo.top 的 script.js（渲染器，站点自带、从未被 CRM 的
 * remote-publisher.ts 写过）按 `post.featured === true` 筛选精选文章，
 * 而 CRM 发布流程的数据模型里**没有**「精选」这个概念——`js/articles-index.js`
 * 的每条数据都没有 `featured` 字段。21 篇文章一篇都筛不出来，首页「精选文章」
 * 区块永远显示空态文案。
 *
 * 01 的决定（选项 A，不改数据模型）：渲染器加一道兜底——筛不出精选文章时，
 * 退回展示最新发布的几篇当精选区内容。以后要用真的「精选」，往某篇文章数据
 * 里加 `featured: true` 就会被优先展示，渲染器逻辑不用再动。
 *
 * 这不是数据文件损坏，是渲染器自带的逻辑缺口，所以不走 buildRescuedRenderer
 * 那条「整体重建数据+渲染器」的管线——script.js 本身完好、也不是 CRM 管的
 * 数据文件。做法是对现有 script.js 做**精确文本替换**，只改
 * displayFeaturedArticles 这一个函数，其余 634 行原样不动。
 *
 * 找不到预期的那段代码就返回 null，拒绝盲改——防止下次站点模板换了、
 * 这段补丁对着不存在的代码空跑，写出语法正确但什么都没改的文件。
 */
export function patchQuibloFeaturedFallback(scriptJs: string): string | null {
  const anchor =
    "    const featured = blogPosts\n" +
    "        .filter(post => post.featured === true)\n" +
    "        .sort((a, b) => new Date(b.date) - new Date(a.date));";

  if (!scriptJs.includes(anchor)) return null;

  const replacement =
    "    let featured = blogPosts\n" +
    "        .filter(post => post.featured === true)\n" +
    "        .sort((a, b) => new Date(b.date) - new Date(a.date));\n" +
    "    // D-370：CRM 的文章数据模型里没有 featured 字段，筛不出来时\n" +
    "    // 退回展示最新发布的几篇，不让这个区块一直空着。\n" +
    "    if (featured.length === 0) {\n" +
    "        featured = blogPosts\n" +
    "            .slice()\n" +
    "            .sort((a, b) => new Date(b.date) - new Date(a.date))\n" +
    "            .slice(0, 3);\n" +
    "    }";

  return scriptJs.replace(anchor, replacement);
}
