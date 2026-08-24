import { NextRequest } from "next/server";
import { getAdminFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { REGION_CODE_MAP } from "@/lib/atc-regions";

export const dynamic = "force-dynamic";

/**
 * D-275 SerpApi Key 池管理（管理员控制台）
 *
 * 原「个人设置 → 广告情报」的 Key 管理整体上收：D-215 起 key 本就是全局共享池
 * （ATC 情报 / 品牌评估 / 上广告竞品创意 / Hermes 商家情报统一取用），与个人无关，
 * 由管理员统一增删测试。user_serpapi_keys 表结构不动，池子取用逻辑（serpapi-key-pool.ts）不动。
 */

function maskKey(key: string): string {
  return `${key.slice(0, 8)}${"*".repeat(Math.max(0, key.length - 8))}`;
}

/** GET — 池内全部 Key（脱敏），带原录入人与冷却状态 */
export async function GET(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const rows = await prisma.user_serpapi_keys.findMany({
    where: { is_deleted: 0 },
    orderBy: { created_at: "asc" },
  });

  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const users = await prisma.users.findMany({
    where: { id: { in: userIds } },
    select: { id: true, username: true, display_name: true },
  });
  const userMap = new Map(users.map((u) => [u.id.toString(), u.display_name || u.username]));

  const data = rows.map((r) => ({
    id: r.id.toString(),
    key_name: r.key_name,
    masked_key: maskKey(r.api_key),
    owner: userMap.get(r.user_id.toString()) || `#${r.user_id}`,
    is_active: r.is_active === 1,
    exhausted_at: r.exhausted_at,
    exhausted_msg: r.exhausted_msg,
    created_at: r.created_at,
  }));
  return apiSuccess(data);
}

/** POST — 新增 Key（记在当前管理员名下，池子全局共享，归属仅作溯源） */
export async function POST(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const body = (await req.json()) as { key_name?: string; api_key?: string };
  const apiKey = (body.api_key ?? "").trim();
  if (!apiKey) return apiError("Key 不能为空");
  if (apiKey.length < 10) return apiError("Key 格式不正确");

  const existing = await prisma.user_serpapi_keys.findFirst({
    where: { api_key: apiKey, is_deleted: 0 },
  });
  if (existing) return apiError("该 Key 已在池内");

  const count = await prisma.user_serpapi_keys.count({ where: { is_deleted: 0 } });
  const keyName = (body.key_name ?? "").trim() || `Key ${count + 1}`;

  await prisma.user_serpapi_keys.create({
    data: { user_id: BigInt(admin.userId), key_name: keyName, api_key: apiKey },
  });
  return apiSuccess(null, "添加成功");
}

/** PATCH — 改备注名 / 启用禁用（任意 Key） */
export async function PATCH(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const body = (await req.json()) as { id?: string; key_name?: string; is_active?: boolean };
  if (!body.id) return apiError("缺少 id");

  const row = await prisma.user_serpapi_keys.findFirst({
    where: { id: BigInt(body.id), is_deleted: 0 },
  });
  if (!row) return apiError("Key 不存在", 404);

  const update: Record<string, unknown> = {};
  if (body.key_name !== undefined) update.key_name = body.key_name.trim() || row.key_name;
  if (body.is_active !== undefined) update.is_active = body.is_active ? 1 : 0;

  await prisma.user_serpapi_keys.update({ where: { id: row.id }, data: update });
  return apiSuccess(null, "已更新");
}

/** DELETE — 软删任意 Key */
export async function DELETE(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const body = (await req.json()) as { id?: string };
  if (!body.id) return apiError("缺少 id");

  const row = await prisma.user_serpapi_keys.findFirst({
    where: { id: BigInt(body.id), is_deleted: 0 },
  });
  if (!row) return apiError("Key 不存在", 404);

  await prisma.user_serpapi_keys.update({ where: { id: row.id }, data: { is_deleted: 1 } });
  return apiSuccess(null, "已删除");
}

/** PUT — 测试 Key（传 id 用库内 Key，传 api_key 测新 Key） */
export async function PUT(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const body = (await req.json()) as { id?: string; api_key?: string };
  let testKey = (body.api_key ?? "").trim();

  if (!testKey && body.id) {
    const row = await prisma.user_serpapi_keys.findFirst({
      where: { id: BigInt(body.id), is_deleted: 0 },
      select: { api_key: true },
    });
    if (!row) return apiError("Key 不存在", 404);
    testKey = row.api_key;
  }
  if (!testKey) return apiError("请提供 Key 或 id");

  try {
    // 该引擎必须提供 advertiser_id 或 text 之一；region 需用 SerpApi 数字码（US=2840）
    const qs = new URLSearchParams({
      engine: "google_ads_transparency_center",
      text: "nike.com",
      region: REGION_CODE_MAP["US"],
      num: "1",
      api_key: testKey,
    }).toString();
    const res = await fetch(`https://serpapi.com/search?${qs}`, {
      signal: AbortSignal.timeout(10000),
    });
    const data = (await res.json()) as { error?: string };
    if (data.error) return apiError(`Key 无效: ${data.error}`);
    return apiSuccess(null, "Key 有效，连接正常");
  } catch (err) {
    return apiError(`连接失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}
