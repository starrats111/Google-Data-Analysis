/**
 * GET /api/cron/find-site-backups — D-370 只读：在站群机上找某个站的渲染器备份
 *
 * 用途：bloomroots.top / novanest.one 的渲染器写在自己的数据文件里、且随文件截断
 * 一起丢了。库里只有文章数据、没有渲染器源码，所以修复函数拒绝执行（见 D-370）。
 * 这个路由去站群机上找还有没有能捞回模板的副本。
 *
 * 只读：只执行固定的 find / ls / head 命令，不写、不删、不改权限。
 * 域名参数只用于拼路径，且先按 /^[a-z0-9.-]+$/ 校验，避免拼进 shell 的注入。
 *
 * 参数：?domain=<域名>（必填）
 * 鉴权：CRON_SECRET（Authorization: Bearer ...）
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { probeSiteBackups } from "@/lib/remote-publisher";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const domain = (url.searchParams.get("domain") || "").trim().toLowerCase();

  // 严格白名单：只允许域名字符。这个值会被拼进 shell 命令，必须挡住注入。
  if (!domain || !/^[a-z0-9][a-z0-9.-]{2,60}$/.test(domain)) {
    return NextResponse.json(
      { ok: false, error: "domain 必填，且只能是域名字符（a-z0-9.-）" },
      { status: 400 },
    );
  }

  const site = await prisma.publish_sites.findFirst({
    where: { domain, is_deleted: 0 },
    select: { id: true, domain: true, site_path: true },
  });
  if (!site || !site.site_path) {
    return NextResponse.json(
      { ok: false, error: `publish_sites 里找不到 ${domain}，或它的 site_path 为空` },
      { status: 404 },
    );
  }

  try {
    const found = await probeSiteBackups(site.site_path, site.domain);
    return NextResponse.json({ ok: true, domain: site.domain, site_path: site.site_path, ...found });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
