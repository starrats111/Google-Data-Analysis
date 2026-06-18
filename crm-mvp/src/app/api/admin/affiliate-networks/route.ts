import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUserFromRequest } from "@/lib/auth";
import { clearAffiliateRulesCache } from "@/lib/affiliate-link-resolver";

async function requireAdmin(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user || user.role !== "admin") return null;
  return user;
}

/** 关键词：接受数组或「逗号/换行分隔」文本，统一小写去重 */
function parseKeywords(input: unknown): string[] {
  let arr: string[] = [];
  if (Array.isArray(input)) arr = input.map((x) => String(x));
  else if (typeof input === "string") arr = input.split(/[\n,，]/);
  return [...new Set(arr.map((s) => s.toLowerCase().trim()).filter(Boolean))];
}

// ---------------------------------------------------------------
// GET  上级联盟库 + 各平台黑名单
// ---------------------------------------------------------------
export async function GET(req: NextRequest) {
  const user = await requireAdmin(req);
  if (!user) return NextResponse.json({ code: -1, message: "无权限" }, { status: 403 });

  const [networks, blacklist] = await Promise.all([
    prisma.parent_networks.findMany({ where: { status: "active" }, orderBy: { label: "asc" } }),
    prisma.platform_blacklist.findMany({ where: { status: "active" }, orderBy: [{ platform: "asc" }, { parent_label: "asc" }] }),
  ]);

  return NextResponse.json({
    code: 0,
    data: {
      networks: networks.map((n) => ({
        id: n.id.toString(),
        label: n.label,
        displayName: n.display_name,
        matchKeywords: (n.match_keywords as unknown as string[]) || [],
        note: n.note,
        updatedAt: n.updated_at,
      })),
      blacklist: blacklist.map((b) => ({
        id: b.id.toString(),
        platform: b.platform,
        parentLabel: b.parent_label,
        note: b.note,
        updatedAt: b.updated_at,
      })),
    },
  });
}

// ---------------------------------------------------------------
// POST  新增/更新（kind=parent 上级联盟 | kind=blacklist 黑名单规则）
// ---------------------------------------------------------------
export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (!user) return NextResponse.json({ code: -1, message: "无权限" }, { status: 403 });

  let body: {
    kind?: string;
    label?: string;
    display_name?: string;
    match_keywords?: string | string[];
    note?: string;
    platform?: string;
    parent_label?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: -1, message: "请求体解析失败" }, { status: 400 });
  }

  if (body.kind === "blacklist") {
    const platform = String(body.platform ?? "").trim().toUpperCase() || "*";
    const parentLabel = String(body.parent_label ?? "").trim().toLowerCase();
    if (!parentLabel) return NextResponse.json({ code: -1, message: "parent_label 必填" }, { status: 400 });
    await prisma.platform_blacklist.upsert({
      where: { platform_parent_label: { platform, parent_label: parentLabel } },
      update: { note: body.note ?? null, status: "active" },
      create: { platform, parent_label: parentLabel, note: body.note ?? null, status: "active" },
    });
    clearAffiliateRulesCache();
    return NextResponse.json({ code: 0, message: "已保存", data: { platform, parentLabel } });
  }

  // 默认 kind=parent
  const display = String(body.label ?? body.display_name ?? "").trim();
  const label = display.toLowerCase();
  if (!label) return NextResponse.json({ code: -1, message: "上级联盟名字必填" }, { status: 400 });
  const kws = parseKeywords(body.match_keywords);
  if (!kws.includes(label)) kws.unshift(label);
  await prisma.parent_networks.upsert({
    where: { label },
    update: { display_name: display, match_keywords: kws as unknown as object, note: body.note ?? null, status: "active" },
    create: { label, display_name: display, match_keywords: kws as unknown as object, note: body.note ?? null, status: "active" },
  });
  clearAffiliateRulesCache();
  return NextResponse.json({ code: 0, message: "已保存", data: { label, matchKeywords: kws } });
}

// ---------------------------------------------------------------
// DELETE  软停用（kind=parent | kind=blacklist）
// ---------------------------------------------------------------
export async function DELETE(req: NextRequest) {
  const user = await requireAdmin(req);
  if (!user) return NextResponse.json({ code: -1, message: "无权限" }, { status: 403 });

  let body: { kind?: string; id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: -1, message: "请求体解析失败" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ code: -1, message: "缺少 id" }, { status: 400 });

  if (body.kind === "blacklist") {
    await prisma.platform_blacklist.update({ where: { id: BigInt(body.id) }, data: { status: "disabled" } });
  } else {
    const row = await prisma.parent_networks.update({
      where: { id: BigInt(body.id) },
      data: { status: "disabled" },
    });
    // 连带停用引用它的黑名单
    if (row?.label) {
      await prisma.platform_blacklist.updateMany({ where: { parent_label: row.label }, data: { status: "disabled" } });
    }
  }
  clearAffiliateRulesCache();
  return NextResponse.json({ code: 0, message: "已删除" });
}
