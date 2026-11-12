import prisma from "@/lib/prisma";
import { normalizePlatformCode } from "@/lib/constants";

/**
 * 打款记录「主连接归一」助手。
 *
 * 背景：联盟「支付/打款」接口是**账户级**返回。同一个物理主账号若用**多把不同 api_key**
 * 配成多条连接（如 RW parcelandplate 的 conn#20/#260/#261，三把 key、同一主账号），
 * 按 api_key 去重无法识别为同一账号，导致同一笔打款单按连接各写一行、重复入库。
 *
 * 解决：把「同 user + 同平台 + 同账号名(account_name)」的多条连接视为同一主账号，
 * 统一把打款记录写到**主连接**下（主连接 = 该组里存活交易最多者，并列取最早建立、再取最小 id）。
 * 次要连接不再各写一份，从源头消除重复（连接本身仍有效保留）。
 *
 * 返回：Map<String(连接id), 主连接id>。对未分组/孤立连接，映射到其自身。
 */
export interface ConnLite {
  id: bigint;
  user_id: bigint;
  platform: string;
  account_name: string | null;
  created_at?: Date | null;
}

export async function resolveMainConnectionMap(conns: ConnLite[]): Promise<Map<string, bigint>> {
  const map = new Map<string, bigint>();
  if (!conns || conns.length === 0) return map;

  // 各连接存活交易数（用于挑主连接）
  const ids = conns.map((c) => c.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = await prisma.$queryRawUnsafe<{ pc: bigint | number; n: bigint | number }[]>(
    `SELECT platform_connection_id pc, COUNT(*) n FROM affiliate_transactions
     WHERE is_deleted = 0 AND platform_connection_id IN (${placeholders})
     GROUP BY platform_connection_id`,
    ...ids.map((x) => Number(x)),
  );
  const countMap = new Map<string, number>(rows.map((r) => [String(r.pc), Number(r.n)]));

  const norm = (s: string | null | undefined) => (s || "").trim().toLowerCase();
  const groups = new Map<string, ConnLite[]>();
  for (const c of conns) {
    const key = `${c.user_id}|${normalizePlatformCode(c.platform)}|${norm(c.account_name)}`;
    const arr = groups.get(key);
    if (arr) arr.push(c);
    else groups.set(key, [c]);
  }

  for (const grp of groups.values()) {
    const main = [...grp].sort((a, b) => {
      const ca = countMap.get(String(a.id)) ?? 0;
      const cb = countMap.get(String(b.id)) ?? 0;
      if (cb !== ca) return cb - ca; // 存活交易多者优先
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      if (ta !== tb) return ta - tb; // 并列取最早建立
      return Number(a.id) - Number(b.id);
    })[0];
    for (const c of grp) map.set(String(c.id), main.id);
  }
  return map;
}

/**
 * D-386：同一真实 payee 配成多条连接，但 account_name 因媒体/子ID 命名各不相同
 * （如 weilixia / weilixia-2 / weilixia-3…），resolveMainConnectionMap 按「账号名」
 * 分组识别不到——联盟支付接口仍是账户级返回，这些子ID连接各自拉取时会拿到同一张
 * 打款单（同 payment_no、同金额），按连接各写一行，佣金在结算报表里被成倍虚增
 * （wj04 案例：PM2 的打款单被 PM3～PM9 各复制一份，应收/实收翻 8 倍）。
 *
 * 用「打款接口实际返回了什么」事后归一，而不是靠账号名猜测：同一 (user, platform,
 * payment_no) 若在本轮被该用户名下多条连接各自拉到，判定为同一笔打款，只认其中
 * **最早建立**的连接（并列取最小 id）为归属连接。不用存活交易数排序——子ID连接的
 * 转化量完全可能反超主账号（wj04 的 weilixia-8 比 weilixia 多得多），按交易数判归属
 * 会选错；而最早建立的连接就是账号被登记时的那条，后添加的多半是同账号下新增的
 * 媒体/子ID追踪连接。
 */
export function resolvePaymentOwnerMap(
  fetched: { conn: ConnLite; paymentNos: string[] }[],
): Map<string, bigint> {
  const groups = new Map<string, ConnLite[]>();
  for (const { conn, paymentNos } of fetched) {
    const platform = normalizePlatformCode(conn.platform);
    const seen = new Set<string>();
    for (const no of paymentNos) {
      if (!no || seen.has(no)) continue;
      seen.add(no);
      const key = `${conn.user_id}|${platform}|${no}`;
      const arr = groups.get(key);
      if (arr) arr.push(conn);
      else groups.set(key, [conn]);
    }
  }
  const owner = new Map<string, bigint>();
  for (const [key, conns] of groups) {
    const main = [...conns].sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      if (ta !== tb) return ta - tb; // 最早建立优先
      return Number(a.id) - Number(b.id);
    })[0];
    owner.set(key, main.id);
  }
  return owner;
}
