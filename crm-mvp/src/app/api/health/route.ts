import prisma from "@/lib/prisma";
import { cacheStats } from "@/lib/cache";

export const dynamic = "force-dynamic";

export async function GET() {
  const startTime = Date.now();

  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    const dbLatency = Date.now() - startTime;
    const mem = process.memoryUsage();

    return Response.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      database: { status: "connected", latency_ms: dbLatency },
      memory: {
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
        external_mb: Math.round(mem.external / 1024 / 1024),
      },
      cache: cacheStats(),
      // 2G 内存警告线：heap > 600MB 时告警
      warning: mem.heapUsed > 600 * 1024 * 1024 ? "内存使用偏高，建议检查" : null,
    });
  } catch (error) {
    return Response.json(
      { status: "unhealthy", timestamp: new Date().toISOString(), database: { status: "disconnected", error: String(error) } },
      { status: 503 }
    );
  }
}
