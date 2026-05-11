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
 * 创建 Prisma client，并在 affiliate_transactions 写入路径上加"运行时闸门"。
 *
 * C-081 联盟交易写入闸门（最终兜底，与代码层 aggregateRawTransactions 双保险）：
 *
 *   规则 A（0/0 幽灵兜底）：
 *     写入 commission_amount=0 AND order_amount=0 时强制 is_deleted=1。
 *     即使代码层漏调 aggregateRawTransactions，DB 层也保证 0/0 行不污染统计。
 *
 *   规则 B（line items 拆单兜底）：
 *     create 时检测同 (user_id, platform, merchant_id, transaction_time) 是否已有活跃行；
 *     存在则把新 commission/order_amount SUM 到现有行，跳过新建。
 *     即使未来接入新平台漏调 aggregate，DB 层也保证不会再产生 line items 拆单。
 *
 * 设计：用 base client 执行 extension 内部 query，避免循环触发自身 hook。
 */
function buildPrisma() {
  const baseClient = globalForPrisma.prismaBase ?? new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "production" ? ["error"] : ["query", "error", "warn"],
  });
  globalForPrisma.prismaBase = baseClient;

  return baseClient.$extends({
    name: "affiliate-txn-write-guard",
    query: {
      affiliate_transactions: {
        async create({ args, query }) {
          const data = args.data as Record<string, unknown>;
          if (!data || typeof data !== "object" || Array.isArray(data)) return query(args);

          const comm = Number(data.commission_amount ?? 0);
          const amt = Number(data.order_amount ?? 0);

          if (comm === 0 && amt === 0) {
            data.is_deleted = 1;
          }

          const userId = data.user_id as bigint | string | number | undefined;
          const platform = data.platform as string | undefined;
          const merchantId = data.merchant_id as string | undefined;
          const transactionTime = data.transaction_time as Date | string | undefined;
          const transactionId = data.transaction_id as string | undefined;

          if (userId && platform && merchantId && transactionTime && transactionId) {
            const existing = await baseClient.affiliate_transactions.findFirst({
              where: {
                user_id: typeof userId === "bigint" ? userId : BigInt(String(userId)),
                platform,
                merchant_id: merchantId,
                transaction_time: transactionTime instanceof Date ? transactionTime : new Date(transactionTime),
                is_deleted: 0,
                transaction_id: { not: transactionId },
              },
              select: { id: true, transaction_id: true },
              orderBy: { transaction_id: "asc" },
            });

            if (existing) {
              const merged = await baseClient.affiliate_transactions.update({
                where: { id: existing.id },
                data: {
                  commission_amount: { increment: comm },
                  order_amount: { increment: amt },
                },
              });
              console.warn(
                `[affiliate-guard] line items 拆单兜底：合并 ${platform}/${merchantId}/${transactionTime} ` +
                `新 id=${transactionId}（+$${comm.toFixed(2)}）→ 已存在 id=${existing.transaction_id}`
              );
              return merged;
            }
          }

          return query(args);
        },

        async upsert({ args, query }) {
          if (args.create && typeof args.create === "object" && !Array.isArray(args.create)) {
            const c = args.create as Record<string, unknown>;
            const comm = Number(c.commission_amount ?? 0);
            const amt = Number(c.order_amount ?? 0);
            if (comm === 0 && amt === 0) c.is_deleted = 1;
          }
          if (args.update && typeof args.update === "object" && !Array.isArray(args.update)) {
            const u = args.update as Record<string, unknown>;
            const commDef = u.commission_amount;
            const amtDef = u.order_amount;
            if (commDef !== undefined && amtDef !== undefined) {
              const comm = Number(commDef);
              const amt = Number(amtDef);
              if (comm === 0 && amt === 0) u.is_deleted = 1;
            }
          }
          return query(args);
        },

        async createMany({ args, query }) {
          if (Array.isArray(args.data)) {
            const rows = args.data as unknown as Record<string, unknown>[];
            const guarded = rows.map((row) => {
              const comm = Number(row.commission_amount ?? 0);
              const amt = Number(row.order_amount ?? 0);
              if (comm === 0 && amt === 0) {
                return { ...row, is_deleted: 1 };
              }
              return row;
            });
            args.data = guarded as unknown as typeof args.data;
          }
          return query(args);
        },

        async updateMany({ args, query }) {
          if (args.data && typeof args.data === "object" && !Array.isArray(args.data)) {
            const d = args.data as Record<string, unknown>;
            const commDef = d.commission_amount;
            const amtDef = d.order_amount;
            if (commDef !== undefined && amtDef !== undefined) {
              const comm = Number(commDef);
              const amt = Number(amtDef);
              if (comm === 0 && amt === 0) d.is_deleted = 1;
            }
          }
          return query(args);
        },
      },
    },
  });
}

// 类型上 export 原始 PrismaClient 类型（避免 DynamicClientExtensionThis 影响下游代码）。
// 运行时 extension 仍生效（query 钩子在底层 baseClient 上注册）。
export const prisma = (globalForPrisma.prisma ?? buildPrisma()) as unknown as PrismaClient;
globalForPrisma.prisma = prisma as unknown as ReturnType<typeof buildPrisma>;

export default prisma;
