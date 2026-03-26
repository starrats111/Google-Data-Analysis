import prisma from "@/lib/prisma";
import {
  verifySiteWithAutoRegister,
  type VerifyResult,
  type PublicSiteAccessResult,
  type BtPanelRegistrationResult,
  type A1StandardizationResult,
} from "@/lib/remote-publisher";

type VerifyOutcome =
  | {
      ok: true;
      site: { id: bigint; site_name: string };
      checks: VerifyResult;
      publicAccess: PublicSiteAccessResult;
      autoStandardizeAttempted: boolean;
      a1Standardization?: A1StandardizationResult;
      autoRegisterAttempted: boolean;
      panelRegistration?: BtPanelRegistrationResult;
    }
  | { ok: false; message: string; status: number };

export async function verifyPublishSiteById(siteId: bigint): Promise<VerifyOutcome> {
  const site = await prisma.publish_sites.findFirst({
    where: { id: siteId, is_deleted: 0 },
  });
  if (!site) return { ok: false, message: "站点不存在", status: 404 };
  if (!site.site_path) return { ok: false, message: "站点路径未配置", status: 400 };

  const verifyResult = await verifySiteWithAutoRegister(site.domain, site.site_path);
  const {
    checks,
    publicAccess,
    fullyVerified,
    autoStandardizeAttempted,
    a1Standardization,
    autoRegisterAttempted,
    panelRegistration,
  } = verifyResult;

  const updateData: Record<string, unknown> = {
    verified: fullyVerified ? 1 : 0,
  };
  if (checks.site_type) {
    updateData.site_type = checks.site_type;
    updateData.data_js_path = checks.data_js_path || site.data_js_path;
    updateData.article_var_name = checks.article_var_name;
    updateData.article_html_pattern = checks.article_html_pattern;
  }

  await prisma.publish_sites.update({
    where: { id: siteId },
    data: updateData,
  });

  return {
    ok: true,
    site: { id: site.id, site_name: site.site_name },
    checks,
    publicAccess,
    autoStandardizeAttempted,
    a1Standardization,
    autoRegisterAttempted,
    panelRegistration,
  };
}
