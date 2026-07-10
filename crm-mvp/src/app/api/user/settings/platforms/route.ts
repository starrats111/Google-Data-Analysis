import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const connections = await prisma.platform_connections.findMany({
    where: { user_id: BigInt(user.userId), is_deleted: 0 },
    orderBy: [{ platform: "asc" }, { created_at: "asc" }],
  });
  return apiSuccess(serializeData(connections));
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { id, platform, account_name, api_key, publish_site_id, payee, payment_method_id } = await req.json();
  if (!platform) return apiError("平台代码不能为空");

  const userId = BigInt(user.userId);
  const normalizedPayee = typeof payee === "string" ? payee.trim() : "";

  // R-01：校验收款方式属于本人所在小组（payment_method_id 传 null 表示解绑）
  let methodId: bigint | null | undefined = undefined;
  if (payment_method_id !== undefined) {
    if (payment_method_id === null || payment_method_id === "") {
      methodId = null;
    } else {
      const me = await prisma.users.findFirst({
        where: { id: userId, is_deleted: 0 },
        select: { team_id: true },
      });
      const method = await prisma.payment_methods.findFirst({
        where: { id: BigInt(payment_method_id), is_deleted: 0 },
        select: { id: true, team_id: true },
      });
      if (!method || !me?.team_id || method.team_id !== me.team_id) {
        return apiError("收款方式不存在或不属于本组");
      }
      methodId = method.id;
    }
  }

  // 编辑模式：按 id 更新
  if (id) {
    const existing = await prisma.platform_connections.findFirst({
      where: { id: BigInt(id), user_id: userId, is_deleted: 0 },
    });
    if (!existing) return apiError("连接不存在");

    // D-163⑪：与其他字段同策略——请求体未带 publish_site_id 时不动它；显式传 null/"" 才解绑。
    // 否则脚本/集成只更新其他字段时会静默解绑发布站点
    const data: Record<string, unknown> = {};
    if (publish_site_id !== undefined) {
      data.publish_site_id = publish_site_id ? BigInt(publish_site_id) : null;
    }
    if (account_name !== undefined) data.account_name = account_name;
    if (api_key && api_key.trim()) data.api_key = api_key;
    if (payee !== undefined) data.payee = normalizedPayee || null;
    if (methodId !== undefined) data.payment_method_id = methodId;

    await prisma.platform_connections.update({ where: { id: existing.id }, data });
    return apiSuccess(null, "保存成功");
  }

  // 新增模式：允许同一平台多个连接
  if (!api_key || !api_key.trim()) return apiError("新增连接时 API Key 不能为空");
  const trimmedKey = api_key.trim();
  const providedName = account_name?.trim() || "";

  // 连接去重（根治「串号」复发）：同一物理账号被重复建成两条连接后，txn-sync 会把新订单打到
  // 「当前被同步的连接 id」，而历史 campaigns/user_merchants 仍指向旧连接 id → 订单账号≠刷点击账号。
  //   ① 同 (user,platform,api_key) 已有 active 连接 → 判定为同一账号：复用并更新，绝不新建重复连接。
  const sameKeyConn = await prisma.platform_connections.findFirst({
    where: { user_id: userId, platform, api_key: trimmedKey, is_deleted: 0 },
    select: { id: true, account_name: true },
  });
  if (sameKeyConn) {
    const data: Record<string, unknown> = {};
    if (providedName) data.account_name = providedName;
    if (payee !== undefined) data.payee = normalizedPayee || null;
    if (methodId !== undefined) data.payment_method_id = methodId;
    if (publish_site_id !== undefined) data.publish_site_id = publish_site_id ? BigInt(publish_site_id) : null;
    if (Object.keys(data).length > 0) {
      await prisma.platform_connections.update({ where: { id: sameKeyConn.id }, data });
    }
    triggerAutoSyncAfterCreate(userId, platform).catch((e) => {
      console.error(`[D-012 auto-sync] init failed for user=${userId} platform=${platform}:`, e);
    });
    return apiSuccess(null, `该平台已存在相同凭据的连接「${sameKeyConn.account_name}」，已复用并更新，未新建重复连接`);
  }

  //   ② 用户显式指定的名字与现有 active 连接同名（多为「换 API Key 却走了新建」）→ 拦截并引导去「编辑」
  //      现有连接更新 Key（保持连接 id 不变），避免同一账号的订单与刷点击分裂到两条连接。
  if (providedName) {
    const sameNameConn = await prisma.platform_connections.findFirst({
      where: { user_id: userId, platform, account_name: providedName, is_deleted: 0 },
      select: { id: true },
    });
    if (sameNameConn) {
      return apiError(
        `该平台已存在同名连接「${providedName}」(id=${sameNameConn.id})。若是更换 API Key，请在该连接上「编辑」更新，不要新建，以免同一账号的订单与刷点击分裂到两条连接。`,
      );
    }
  }

  // 自动生成 account_name（如果未提供）
  let finalName = providedName;
  if (!finalName) {
    const existingCount = await prisma.platform_connections.count({
      where: { user_id: userId, platform, is_deleted: 0 },
    });
    finalName = existingCount === 0 ? `${platform}1` : `${platform}${existingCount + 1}`;
  }

  await prisma.platform_connections.create({
    data: {
      user_id: userId,
      platform,
      account_name: finalName,
      api_key: trimmedKey,
      channel_id: null,
      payee: normalizedPayee || null,
      payment_method_id: methodId ?? null,
      publish_site_id: publish_site_id ? BigInt(publish_site_id) : null,
      status: "connected",
    },
  });

  // D-012: 新增 conn 后 fire-and-forget 触发该平台 sync，
  // 让新 conn 的商家数据立即入库 → 与同平台其他 conn 自然合并形成 MULTI_KEY
  // 治本未来"加了 conn 但 user 没手动点同步导致 user_merchants 缺该 conn 的 link"问题
  triggerAutoSyncAfterCreate(userId, platform).catch((e) => {
    console.error(`[D-012 auto-sync] init failed for user=${userId} platform=${platform}:`, e);
  });

  return apiSuccess(null, "保存成功");
}

// D-012: 新增 platform_connection 后自动触发该 user 该平台的 sync
// 失败不影响主流程（已被 conn 创建成功后调用，不阻塞响应）
async function triggerAutoSyncAfterCreate(userId: bigint, platform: string) {
  // 复用 sync engine（dynamic import 避免循环依赖 + 共享 syncingUsers 单例 lock）
  const { syncingUsers, doSyncInBackground } = await import("@/app/api/user/merchants/sync/route");
  const platformUpper = platform.toUpperCase();
  const lockKey = `${userId.toString()}:${platformUpper}`;
  if (syncingUsers.has(lockKey)) {
    console.log(`[D-012 auto-sync] skipped: user=${userId} platform=${platformUpper} already syncing`);
    return;
  }

  // 拉该 user 在该 platform 的所有 active conn（含刚新增的）
  const conns = await prisma.platform_connections.findMany({
    where: { user_id: userId, platform: platformUpper, is_deleted: 0 },
    select: { id: true, platform: true, account_name: true, api_key: true, channel_id: true },
  });
  const valid = conns.filter((c) => c.api_key && c.api_key.length > 5);
  if (valid.length === 0) {
    console.log(`[D-012 auto-sync] no valid conns for user=${userId} platform=${platformUpper}`);
    return;
  }

  syncingUsers.add(lockKey);
  console.log(`[D-012 auto-sync] triggered user=${userId} platform=${platformUpper} conns=${valid.length}`);

  // fire-and-forget：sync 自己在后台跑，本函数立即返回不阻塞主响应
  doSyncInBackground(userId, valid, platformUpper)
    .catch((e) => console.error(`[D-012 auto-sync ${platformUpper}] doSync failed for user=${userId}:`, e))
    .finally(() => { syncingUsers.delete(lockKey); });
}

export async function DELETE(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { id } = await req.json();
  if (!id) return apiError("缺少 ID");

  const userId = BigInt(user.userId);
  const connId = BigInt(id);

  // 先查出连接信息（平台代码 + 凭据），确认归属当前用户
  const conn = await prisma.platform_connections.findFirst({
    where: { id: connId, user_id: userId, is_deleted: 0 },
    select: { id: true, platform: true, api_key: true },
  });
  if (!conn) return apiError("连接不存在");

  // C-090：保留 excluded 是因为这是用户主动排除的标记，不应被覆盖
  const KEEP_STATUSES = ["claimed", "paused", "excluded"];

  // 软删除平台连接
  await prisma.platform_connections.update({
    where: { id: connId },
    data: { is_deleted: 1 },
  });

  // ── 同账号孪生连接迁移（根治「删旧建新/换密钥」造成的串号）──
  // 场景：同一物理账号被建成两条连接（api_key 完全相同）。删掉其一时，其「保留态」商家与广告系列
  // 若仍指向已删连接 id，就会变成孤儿：新订单会打到孪生连接 id，刷点击/换链却还认旧连接 id → 串号。
  // 仅在存在【唯一】同凭据(api_key 完全一致)的 active 孪生连接时迁移——同账号下追踪链接 token 有效，安全。
  const deletedKey = (conn.api_key || "").trim();
  const otherActive = deletedKey
    ? await prisma.platform_connections.findMany({
        where: { user_id: userId, platform: conn.platform, is_deleted: 0, id: { not: connId } },
        select: { id: true, api_key: true },
      })
    : [];
  const twins = otherActive.filter((t) => (t.api_key || "").trim() === deletedKey);
  const twin = twins.length === 1 ? twins[0] : null;

  if (twin) {
    // 1) 广告系列整体重绑到孪生连接
    await prisma.campaigns.updateMany({
      where: { user_id: userId, platform_connection_id: connId, is_deleted: 0 },
      data: { platform_connection_id: twin.id },
    });
    // 2) 保留态商家：重绑连接 + 把 connection_campaign_links 里旧 connId 的链接键迁到孪生 connId
    const oldKey = connId.toString();
    const newKey = twin.id.toString();
    const keepMerchants = await prisma.user_merchants.findMany({
      where: { user_id: userId, platform_connection_id: connId, status: { in: KEEP_STATUSES }, is_deleted: 0 },
      select: { id: true, connection_campaign_links: true },
    });
    for (const m of keepMerchants) {
      const data: Record<string, unknown> = { platform_connection_id: twin.id };
      const raw = m.connection_campaign_links;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const links = { ...(raw as Record<string, string>) };
        if (typeof links[oldKey] === "string" && links[oldKey] && !links[newKey]) {
          links[newKey] = links[oldKey];
          delete links[oldKey];
          data.connection_campaign_links = links;
        }
      }
      await prisma.user_merchants.update({ where: { id: m.id }, data });
    }
  }

  // 联动清理一：软删除该连接下的所有联盟交易记录
  // 连接删除后，其历史交易数据不再属于用户的有效数据
  await prisma.affiliate_transactions.updateMany({
    where: { user_id: userId, platform_connection_id: connId, is_deleted: 0 },
    data: { is_deleted: 1 },
  });

  // 联动清理三：软删除该连接下的所有打款记录（affiliate_payments）
  // 病灶根除：此前删连接只清交易/商家，漏了打款记录，导致已删连接的打款单
  // 仍残留在「打款明细」里重复显示（典型如同一物理账号双配置后删其一）。
  await prisma.affiliate_payments.updateMany({
    where: { user_id: userId, platform_connection_id: connId, is_deleted: 0 },
    data: { is_deleted: 1 },
  });

  // 联动清理二：软删除该连接带来的非领取商家
  // 规则：已领取（claimed）或已暂停（paused）的不动，其余清除（KEEP_STATUSES 见函数顶部）
  await prisma.user_merchants.updateMany({
    where: {
      user_id: userId,
      platform_connection_id: connId,
      status: { notIn: KEEP_STATUSES },
      is_deleted: 0,
    },
    data: { is_deleted: 1 },
  });

  // C-090：若该平台已无其他有效连接，按 platform 全量清理 available 商家
  // 修复前只清 platform_connection_id=NULL 的，会漏掉指向其他历史 connId 的孤儿
  const otherActiveConns = await prisma.platform_connections.count({
    where: { user_id: userId, platform: conn.platform, is_deleted: 0 },
  });
  if (otherActiveConns === 0) {
    await prisma.user_merchants.updateMany({
      where: {
        user_id: userId,
        platform: conn.platform,
        status: { notIn: KEEP_STATUSES },
        is_deleted: 0,
      },
      data: { is_deleted: 1 },
    });
  }

  return apiSuccess(null, "删除成功");
}
