import prisma from "@/lib/prisma";
import { verifyConnection, type VerifyResult } from "@/lib/remote-publisher";

type VerifyOutcome =
  | { ok: true; site: { id: bigint; site_name: string }; checks: VerifyResult }
  | { ok: false; message: string; status: number };

export async function verifyPublishSiteById(siteId: bigint): Promise<VerifyOutcome> {
  const site = await prisma.publish_sites.findFirst({
    where: { id: siteId, is_deleted: 0 },
  });
  if (!site) return { ok: false, message: "站点不存在", status: 404 };
  if (!site.site_path) return { ok: false, message: "站点路径未配置", status: 400 };

  const checks = await verifyConnection(site.site_path);

  if (checks.site_type) {
    const updateData: Record<string, unknown> = {
      verified: checks.valid ? 1 : 0,
    };
    if (checks.site_type !== site.site_type) {
      updateData.site_type = checks.site_type;
      updateData.data_js_path = checks.data_js_path || site.data_js_path;
      updateData.article_var_name = checks.article_var_name;
      updateData.article_html_pattern = checks.article_html_pattern;
    }
    await prisma.publish_sites.update({
      where: { id: siteId },
      data: updateData,
    });
  } else if (checks.valid) {
    await prisma.publish_sites.update({
      where: { id: siteId },
      data: { verified: 1 },
    });
  }

  return {
    ok: true,
    site: { id: site.id, site_name: site.site_name },
    checks,
  };
}
