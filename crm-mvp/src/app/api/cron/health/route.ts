import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET || "";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const testDb = searchParams.get("db") === "1";

  let dbResult: unknown = null;
  if (testDb) {
    try {
      const t0 = Date.now();
      const count = await prisma.users.count({ where: { is_deleted: 0 } });
      dbResult = { ok: true, user_count: count, ms: Date.now() - t0 };
    } catch (e) {
      dbResult = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return NextResponse.json({
    ok: true,
    ts: new Date().toISOString(),
    secret_len: CRON_SECRET.length,
    env: process.env.NODE_ENV,
    db: dbResult,
  });
}
