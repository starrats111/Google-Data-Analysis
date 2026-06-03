import { PrismaClient } from "@/generated/prisma/client";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";

// Prisma Client 单例（v7 + MariaDB adapter）
// 注意：schema 变更后需重启 dev server 以加载新的 generated client
// ─── 低配生产机连接池 ───
// D-092：默认从 5 提到 15（仍可由 DB_POOL_SIZE 覆盖）。
//   真因：池=5 太小，cron 批量（MerchantAutoLink/sheet-sync）+ 多条并发广告生成 + 定时同步
//   同一时刻挤满 5 个连接 → 后续查询排队 >10s 触发成片 `pool timeout (active=5 idle=0 limit=5)`，
//   生成链路 DB 读写被「直接截断」。MySQL 默认 max_connections=151，15 个连接对 2 核/3.7G 安全
//   （mariadb 原生连接很轻量）。acquireTimeout 同步提到 20s，给瞬时尖峰更多排队缓冲。
const connectionConfig = {
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "3306"),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "crm_mvp",
  connectionLimit: parseInt(process.env.DB_POOL_SIZE || "15", 10),
  acquireTimeout: 20000,
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
