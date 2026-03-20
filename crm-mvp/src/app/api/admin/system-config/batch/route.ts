import { NextRequest } from "next/server";
import { getAdminFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { clearConfigCache, CONFIG_GROUPS, CONFIG_KEY_DESCRIPTIONS } from "@/lib/system-config";

// 收集所有合法的配置 key
const ALL_ALLOWED_KEYS = new Set<string>();
for (const group of Object.values(CONFIG_GROUPS)) {
  for (const field of group.fields) {
    ALL_ALLOWED_KEYS.add(field.key);
  }
}

// POST — 批量保存某个分组的配置（宝塔 / 后端 / AI）
export async function POST(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const body = await req.json();

  let savedCount = 0;
  for (const [key, value] of Object.entries(body)) {
    if (!ALL_ALLOWED_KEYS.has(key)) continue;

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
          description: CONFIG_KEY_DESCRIPTIONS[key] || null,
        },
      });
    }
    savedCount++;
  }

  // 清除配置缓存
  clearConfigCache();

  return apiSuccess({ saved: savedCount }, "配置已保存");
}

// GET — 获取所有分组配置的当前值
export async function GET(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const rows = await prisma.system_configs.findMany({
    where: { is_deleted: 0 },
    select: { config_key: true, config_value: true },
  });

  const configMap: Record<string, string> = {};
  for (const row of rows) {
    if (ALL_ALLOWED_KEYS.has(row.config_key)) {
      configMap[row.config_key] = row.config_value || "";
    }
  }

  return apiSuccess(configMap);
}
