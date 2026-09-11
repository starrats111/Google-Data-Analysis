import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError, normalizePlatformCode } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { nowCST } from "@/lib/date-utils";
import { markConnectionSuccess, markConnectionReachable, markConnectionFailure } from "@/lib/connection-health";

/**
 * POST /api/user/data-center/sync-payments
 *
 * D-072：调用各联盟平台「支付/打款」API，把实付记录写入 affiliate_payments。
 * 数据来源：platform_connections 中已连接账号的 api_key。
 *
 * body: { days?: number }  // 不传则从 2025-01-01 起全量
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const userId = BigInt(user.userId);
  // D-079：组长点击「同步已支付」时，同步整个团队成员的支付连接（与团队报表/结算口径一致）；
  // 普通成员仅同步自己。每条打款按「连接所属成员」归属，不挂到组长名下。
  const isLeader = user.role === "leader" && !!user.teamId;
  const body = await req.json().catch(() => ({}));

  const now = nowCST();
  const DEFAULT_START = "2025-01-01";
  const startStr = body.days ? now.subtract(body.days, "day").format("YYYY-MM-DD") : DEFAULT_START;
  const endStr = now.format("YYYY-MM-DD");

  try {
    let ownerIds: bigint[] = [userId];
    if (isLeader) {
      const members = await prisma.users.findMany({
        where: { team_id: BigInt(user.teamId!), is_deleted: 0, role: { not: "admin" } },
        select: { id: true },
      });
      ownerIds = members.map((m) => m.id);
    }

    const connections = ownerIds.length === 0
      ? []
      : await prisma.platform_connections.findMany({
          where: { user_id: { in: ownerIds }, is_deleted: 0, status: "connected" },
          select: { id: true, user_id: true, platform: true, account_name: true, api_key: true, channel_id: true, created_at: true, payment_account_key: true },
        });

    const { fetchPlatformPayments, platformSupportsPayments } = await import("@/lib/payment-api");
    const { resolveMainConnectionMap } = await import("@/lib/payment-main-connection");
    // 同一物理账户的多连接 → 打款统一写主连接，避免账户级打款单按 api_key 重复入库
    const mainConnMap = await resolveMainConnectionMap(connections);
    // D-322：打款行必须整行归主连接——user_id 也取主连接的归属人。
    // 否则跨成员误挂时会写出 user_id=A 但 platform_connection_id 指向 B 连接的错行，
    // 报表按 conn 关联账号列、按 user_id 过滤，这种行会错列或凭空消失。
    const ownerByConnId = new Map(connections.map((c) => [String(c.id), c.user_id]));

    const validConnsRaw = connections
      .filter((c) => c.api_key && c.api_key.length > 5 && platformSupportsPayments(normalizePlatformCode(c.platform)))
      .sort((a, b) => Number(b.id) - Number(a.id));

    // 病灶根除：联盟「支付/打款」接口按 api_key（账号级）返回，与连接(channel/成员)无关。
    // 同一物理账号若配置了多条连接（如同一 CG 账号挂在不同成员名下），逐条同步会把
    // 同一笔打款单写成多行。每个物理账号只同步一次。
    // D-322：去重键优先用 payment_account_key（显式物理账户）——同一账户签发多把 key 时
    // 按 api_key 去重不命中，会各拉一遍再各写一份。未标注的回退 api_key。
    const seenAccounts = new Set<string>();
    const validConns = validConnsRaw.filter((c) => {
      const platform = normalizePlatformCode(c.platform);
      const acctKey = (c.payment_account_key || "").trim().toLowerCase();
      const key = acctKey ? `${platform}::acct::${acctKey}` : `${platform}::${c.api_key}`;
      if (seenAccounts.has(key)) return false;
      seenAccounts.add(key);
      return true;
    });

    if (validConns.length === 0) {
      return apiError(
        isLeader
          ? "团队成员均未配置支持「支付 API」的已连接平台"
          : "没有支持「支付 API」的已连接平台，请先在「个人设置 → 联盟平台连接」中配置",
        400,
      );
    }

    // 串行拉取（支付接口数据量小，避免并发压垮平台）
    const accountResults: { account_name: string; platform: string; synced: number; total_fetched: number; paid_amount: number; error?: string }[] = [];
    let totalSynced = 0;
    let totalPaidAmount = 0;

    for (const conn of validConns) {
      const platform = normalizePlatformCode(conn.platform);
      const label = conn.account_name || platform;
      let payments: Awaited<ReturnType<typeof fetchPlatformPayments>>["payments"] = [];
      let error: string | undefined;
      try {
        const r = await fetchPlatformPayments(platform, conn.api_key!, startStr, endStr);
        payments = r.payments;
        error = r.error;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      if (error && payments.length === 0) {
        await markConnectionFailure(conn.id, error);
        accountResults.push({ account_name: label, platform, synced: 0, total_fetched: 0, paid_amount: 0, error });
        continue;
      }
      if (payments.length === 0) {
        await markConnectionReachable(conn.id);
        accountResults.push({ account_name: label, platform, synced: 0, total_fetched: 0, paid_amount: 0, error });
        continue;
      }
      await markConnectionSuccess(conn.id);

      const mainConnId = mainConnMap.get(String(conn.id)) ?? conn.id;
      const ownerId = ownerByConnId.get(String(mainConnId)) ?? conn.user_id;
      let synced = 0;
      let paidAmount = 0;
      for (let i = 0; i < payments.length; i += 50) {
        const batch = payments.slice(i, i + 50);
        await Promise.all(
          batch.map((p) => {
            if (p.status === "paid") paidAmount += p.amount;
            return prisma.affiliate_payments.upsert({
              where: {
                platform_platform_connection_id_payment_no: {
                  platform,
                  platform_connection_id: mainConnId,
                  payment_no: p.payment_no,
                },
              },
              create: {
                user_id: ownerId,
                platform,
                platform_connection_id: mainConnId,
                payment_no: p.payment_no,
                source_kind: p.source_kind,
                paid_date: p.paid_date ? new Date(p.paid_date) : null,
                request_date: p.request_date ? new Date(p.request_date) : null,
                amount: p.amount,
                gross_amount: p.gross_amount ?? null,
                currency: p.currency,
                status: p.status,
                raw_status: p.raw_status || null,
                payment_type: p.payment_type ?? null,
                raw_json: p.raw_json || null,
              },
              update: {
                user_id: ownerId, // D-322：修正存量错归的行（跨成员误挂时旧行 user_id 是次要连接的人）
                source_kind: p.source_kind,
                paid_date: p.paid_date ? new Date(p.paid_date) : null,
                request_date: p.request_date ? new Date(p.request_date) : null,
                amount: p.amount,
                gross_amount: p.gross_amount ?? null,
                status: p.status,
                raw_status: p.raw_status || null,
                payment_type: p.payment_type ?? null,
                raw_json: p.raw_json || null,
                is_deleted: 0,
              },
            });
          }),
        );
        synced += batch.length;
      }

      totalSynced += synced;
      totalPaidAmount += paidAmount;
      accountResults.push({
        account_name: label,
        platform,
        synced,
        total_fetched: payments.length,
        paid_amount: +paidAmount.toFixed(2),
        error,
      });
    }

    const msg = accountResults
      .map((r) => `${r.account_name}: ${r.synced}笔/$${r.paid_amount.toFixed(2)}${r.error ? ` (${r.error})` : ""}`)
      .join("；");

    return apiSuccess(serializeData({
      synced: totalSynced,
      paid_amount: +totalPaidAmount.toFixed(2),
      accounts: accountResults,
      message: `支付同步完成 — ${msg}`,
    }));
  } catch (err) {
    return apiError(`支付同步失败: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
}
