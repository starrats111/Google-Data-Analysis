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
