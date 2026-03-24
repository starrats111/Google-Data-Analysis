/**
 * 部署配置 API — 管理 SSH 配置与 Token 池
 */
import { NextRequest } from "next/server";
import { apiSuccess } from "@/lib/constants";
import { withAdmin } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { getTokenPool, saveTokenPool } from "@/lib/deploy-credentials";
import { clearConfigCache } from "@/lib/system-config";

const SERVER_CONFIG_KEYS = [
  "bt_ssh_host",
  "bt_ssh_port",
  "bt_ssh_user",
  "bt_ssh_password",
  "bt_ssh_key_path",
  "bt_ssh_key_content",
  "bt_site_root",
] as const;

const KEY_DESCRIPTIONS: Record<string, string> = {
  bt_ssh_host: "宝塔服务器 IP",
  bt_ssh_port: "SSH 端口",
  bt_ssh_user: "SSH 用户名",
  bt_ssh_password: "SSH 密码",
  bt_ssh_key_path: "SSH 密钥路径",
  bt_ssh_key_content: "SSH 密钥内容（上传的私钥文件）",
  bt_site_root: "网站根目录",
};

export const GET = withAdmin(async () => {
  const rows = await prisma.system_configs.findMany({
    where: { is_deleted: 0, config_key: { in: [...SERVER_CONFIG_KEYS] } },
    select: { config_key: true, config_value: true },
  });

  const config: Record<string, unknown> = {};
  for (const row of rows) {
    config[row.config_key] = row.config_value || "";
  }

  const pool = await getTokenPool();
  config.token_pool = pool;

  return apiSuccess({ config });
});

export const POST = withAdmin(async (req: NextRequest) => {
  const body = await req.json();
  const allowedSet = new Set<string>(SERVER_CONFIG_KEYS);
  const serverConfigEntries = Object.entries(body).filter(([key]) => allowedSet.has(key));

  let savedCount = 0;
  for (const [key, value] of serverConfigEntries) {
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

  const rawPool = body.token_pool;
  const pool = await saveTokenPool(rawPool);
  clearConfigCache();

  return apiSuccess(
    {
      saved: savedCount,
      config: {
        ...body,
        token_pool: pool,
      },
    },
    "部署配置已保存",
  );
});
