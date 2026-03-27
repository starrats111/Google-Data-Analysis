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
