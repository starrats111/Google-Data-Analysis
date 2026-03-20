/**
 * 部署配置 API — 管理 SSH / GitHub / Cloudflare 等部署配置
 * 支持从数据分析平台后端同步配置到 CRM 的 system_configs 表
 */
import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withAdmin } from "@/lib/api-handler";
import { getBackendConfig, clearConfigCache } from "@/lib/system-config";
import prisma from "@/lib/prisma";

const DEPLOY_KEYS = [
  "bt_ssh_host", "bt_ssh_port", "bt_ssh_user",
  "bt_ssh_password", "bt_ssh_key_path", "bt_ssh_key_content",
  "bt_site_root",
  "github_token", "github_org",
  "cf_token", "bt_server_ip",
];

const KEY_DESCRIPTIONS: Record<string, string> = {
  bt_ssh_host: "宝塔服务器 IP",
  bt_ssh_port: "SSH 端口",
  bt_ssh_user: "SSH 用户名",
  bt_ssh_password: "SSH 密码",
  bt_ssh_key_path: "SSH 密钥路径",
  bt_ssh_key_content: "SSH 密钥内容（上传的私钥文件）",
  bt_site_root: "网站根目录",
  github_token: "GitHub Token",
  github_org: "GitHub 组织/用户名",
  cf_token: "Cloudflare API Token",
  bt_server_ip: "宝塔服务器公网 IP",
};

// GET — 读取 CRM 本地已保存的部署配置
export const GET = withAdmin(async () => {
  const rows = await prisma.system_configs.findMany({
    where: { is_deleted: 0, config_key: { in: DEPLOY_KEYS } },
    select: { config_key: true, config_value: true },
  });

  const config: Record<string, string> = {};
  for (const row of rows) {
    config[row.config_key] = row.config_value || "";
  }

  return apiSuccess({ config });
});

// POST — 保存部署配置到 CRM 数据库
export const POST = withAdmin(async (req: NextRequest) => {
  const body = await req.json();
  const allowedSet = new Set(DEPLOY_KEYS);

  let savedCount = 0;
  for (const [key, value] of Object.entries(body)) {
    if (!allowedSet.has(key)) continue;
    const strValue = value != null ? String(value) : "";

    const existing = await prisma.system_configs.findFirst({
      where: { config_key: key, is_deleted: 0 },
    });

    if (existing) {
      await prisma.system_configs.update({
        where: { id: existing.id },
        data: { config_value: strValue || null },
      });
    } else if (strValue) {
      await prisma.system_configs.create({
        data: {
          config_key: key,
          config_value: strValue,
          description: KEY_DESCRIPTIONS[key] || null,
        },
      });
    }
    savedCount++;
  }

  clearConfigCache();
  return apiSuccess({ saved: savedCount }, "部署配置已保存");
});
