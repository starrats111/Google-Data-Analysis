import { PrismaClient } from "@/generated/prisma/client";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";

// Prisma Client 单例（v7 + MariaDB adapter）
// 注意：schema 变更后需重启 dev server 以加载新的 generated client
// ─── 低配生产机连接池 ───
// 默认可通过 DB_POOL_SIZE 覆盖。3~4G 内存机型默认 5：过小易排队超时，过大占内存。
// （每个连接约 10~20MB，仍远低于滥用 10+ 连接）
const connectionConfig = {
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "3306"),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "crm_mvp",
  connectionLimit: parseInt(process.env.DB_POOL_SIZE || "5", 10),
  acquireTimeout: 10000,
  idleTimeout: 30000,
  minimumIdle: 1,
};

const adapter = new PrismaMariaDb(connectionConfig);

const globalForPrisma = globalThis as unknown as {
  prismaBase: PrismaClient | undefined;
  prisma: ReturnType<typeof buildPrisma> | undefined;
};

/**
 * 创建 Prisma client。
 *
 * C-081 联盟交易写入闸门（**C-086 起完全撤销**）：
 *
 *   原 C-081 在 affiliate_transactions 写入路径上加了两条 DB 层兜底规则：
 *     - 规则 A：0/0 行自动 is_deleted=1（防 ghost 污染）
 *     - 规则 B：同 (user, platform, merchant, time) 多 transaction_id 自动 SUM 合并
 *
 *   C-086 后聚合维度变为 `(merchant_id, order_id)`（fallback time）：
 *     - 整单 0/0 lead 订单需要保留以对齐平台后台 distinct order_id 单数 → 规则 A 撤销
 *     - 同 transaction_time 但不同 order_id 的两笔订单应该写成 2 行 → 规则 B 撤销
 *       （否则会错误合并相邻订单，造成单数低估）
 *
 *   现在写入正确性完全由代码层 aggregateRawTransactions（affiliate-txn-aggregate.ts）
 *   单方面保证。所有调用方都必须先调它再写入（强制规约，详见该文件文档）。
 */
function buildPrisma() {
  const baseClient = globalForPrisma.prismaBase ?? new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "production" ? ["error"] : ["query", "error", "warn"],
  });
  globalForPrisma.prismaBase = baseClient;
  return baseClient;
}

export const prisma = globalForPrisma.prisma ?? buildPrisma();
globalForPrisma.prisma = prisma;

export default prisma;
