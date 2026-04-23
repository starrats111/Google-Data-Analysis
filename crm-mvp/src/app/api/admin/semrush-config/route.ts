import { NextRequest } from "next/server";
import { getAdminFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

// SemRush 配置项定义
const SEMRUSH_KEYS = [
  { key: "semrush_username", label: "用户名", required: true },
  { key: "semrush_password", label: "密码", required: true },
  { key: "semrush_user_id", label: "User ID", required: true },
  { key: "semrush_api_key", label: "API Key", required: true },
  { key: "semrush_node", label: "节点", required: false, default: "3" },
  { key: "semrush_database", label: "默认数据库", required: false, default: "us" },
] as const;

/** GET — 获取所有 SemRush 配置 */
export async function GET(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const rows = await prisma.system_configs.findMany({
    where: {
      config_key: { startsWith: "semrush_" },
      is_deleted: 0,
    },
  });

  // 组装为对象形式返回
  const configMap: Record<string, string> = {};
  for (const row of rows) {
    configMap[row.config_key] = row.config_value || "";
  }

  // 补全缺失的 key（用默认值）
  for (const def of SEMRUSH_KEYS) {
    if (!(def.key in configMap)) {
      configMap[def.key] = ("default" in def ? def.default : "") as string;
    }
  }

  return apiSuccess({
    config: configMap,
    fields: SEMRUSH_KEYS,
  });
}

/** PUT — 批量更新 SemRush 配置 */
export async function PUT(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const body = await req.json();
  const config: Record<string, string> = body.config || {};

  // 校验必填项
  for (const def of SEMRUSH_KEYS) {
    if (def.required && !config[def.key]?.trim()) {
      return apiError(`${def.label} 不能为空`);
    }
  }

  // 逐个 upsert：findFirst 不过滤 is_deleted，避免软删除后 create 触发唯一约束冲突
  for (const def of SEMRUSH_KEYS) {
    const value = config[def.key]?.trim() || ("default" in def ? def.default : "") as string;
    const existing = await prisma.system_configs.findFirst({
      where: { config_key: def.key },
    });

    if (existing) {
      await prisma.system_configs.update({
        where: { id: existing.id },
        data: { config_value: value, description: `SemRush ${def.label}`, is_deleted: 0 },
      });
    } else {
      await prisma.system_configs.create({
        data: {
          config_key: def.key,
          config_value: value,
          description: `SemRush ${def.label}`,
        },
      });
    }
  }

  return apiSuccess(null, "SemRush 配置已保存");
}

/** DELETE — 清除所有 SemRush 配置（软删除） */
export async function DELETE(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  await prisma.system_configs.updateMany({
    where: {
      config_key: { startsWith: "semrush_" },
      is_deleted: 0,
    },
    data: { is_deleted: 1 },
  });

  return apiSuccess(null, "SemRush 配置已清除");
}
