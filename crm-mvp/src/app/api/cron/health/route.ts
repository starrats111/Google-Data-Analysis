import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET || "";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("[CRON health] ping received");

  return NextResponse.json({
    ok: true,
    ts: new Date().toISOString(),
    secret_len: CRON_SECRET.length,
    env: process.env.NODE_ENV,
  });
}
