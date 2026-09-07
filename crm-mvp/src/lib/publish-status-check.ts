/**
 * D-326：发布请求断线后的状态回查。
 *
 * 「发布到站点」是一个同步长请求：服务端要逐张下载正文里的外链图，再 SFTP 推到站群机。
 * 遇到「连得上但一个字节都不回」的图床时（2026-09-07 wj11 那篇文章里的
 * static.musicarts.com 就是，Akamai 对具体对象静默黑洞），单张图能把重试预算跑满，
 * 整个请求轻松超过 CDN 的 100 秒上限被掐断。
 *
 * 但**连接断了不等于没发出去**——wj11 那两次「转圈发不出去」，服务端其实都发成功了，
 * 文章早就在站上。所以前端断线后不许直接报失败，要回来查一次文章状态。
 *
 * 判定口径：只认「status=published 且 updated_at 比本次发起前更新」。
 * 光看 status 是不够的——一篇早就发布过的文章会让任何一次失败都被读成成功。
 * 基线和回查值都取自服务端的 updated_at，因此不受用户本机时钟影响。
 */

/** 前端发布请求的超时。取 90 秒是为了赶在 CDN 的 100 秒之前自己断，好走到回查这一步。 */
export const PUBLISH_TIMEOUT_MS = 90000;

type ArticleRow = { status?: string; updated_at?: string; published_url?: string | null };

async function fetchArticleRow(articleId: string): Promise<ArticleRow | null> {
  const res = await fetch(
    `/api/user/articles?id=${encodeURIComponent(articleId)}&page=1&pageSize=1`
  ).then((r) => r.json());
  return res.data?.articles?.[0] ?? null;
}

/** 读一次文章当前的 updated_at（毫秒）。取不到返回 null，调用方按「无基线」降级。 */
export async function readArticleUpdatedAt(articleId: string): Promise<number | null> {
  try {
    const raw = (await fetchArticleRow(articleId))?.updated_at;
    const ms = raw ? new Date(raw).getTime() : NaN;
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * 回查这一次发布到底成没成功。成功返回文章地址，否则返回 null。
 * 服务端可能比前端的超时晚几秒才落库，所以隔 3 秒重试，最多查 3 次。
 */
export async function confirmPublishedAfter(
  articleId: string,
  baseUpdatedAt: number | null,
): Promise<{ url: string } | null> {
  for (let i = 0; i < 3; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 3000));
    try {
      const a = await fetchArticleRow(articleId);
      if (a?.status !== "published") continue;
      const updatedAt = a.updated_at ? new Date(a.updated_at).getTime() : NaN;
      if (baseUpdatedAt !== null && Number.isFinite(updatedAt) && updatedAt <= baseUpdatedAt) continue;
      return { url: a.published_url || "" };
    } catch {
      // 网络抖动，下一轮再试
    }
  }
  return null;
}
