import { PrismaClient } from "@/generated/prisma/client";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";

// Prisma Client 单例（v7 + MariaDB adapter）
// 注意：schema 变更后需重启 dev server 以加载新的 generated client
// ─── 2核2G 服务器优化配置 ───
// MariaDB 连接池：限制 3 个连接（每个连接约 10-20MB 内存）
// 默认 10 个连接在 2G 内存下会占用 100-200MB，太浪费
const connectionConfig = {
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "3306"),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "crm_mvp",
  connectionLimit: parseInt(process.env.DB_POOL_SIZE || "3"),  // 2G 内存限制 3 个连接
  acquireTimeout: 10000,   // 获取连接超时 10 秒
  idleTimeout: 30000,      // 空闲连接 30 秒后回收
  minimumIdle: 1,          // 最少保持 1 个空闲连接
};

const adapter = new PrismaMariaDb(connectionConfig);

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === "production"
    ? ["error"]
    : ["query", "error", "warn"],
});

globalForPrisma.prisma = prisma;

export default prisma;
