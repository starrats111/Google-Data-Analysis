/**
 * SSH 密钥文件上传 API
 * 支持拖动上传 SSH 私钥文件，内容存储到 system_configs 表
 */
import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withAdmin } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { clearConfigCache } from "@/lib/system-config";

// POST — 上传 SSH 密钥文件
export const POST = withAdmin(async (req: NextRequest) => {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return apiError("请选择密钥文件");
    }

    // 验证文件大小（最大 32KB，SSH 密钥通常很小）
    if (file.size > 32 * 1024) {
      return apiError("密钥文件过大，最大支持 32KB");
    }

    // 读取文件内容
    const content = await file.text();

    // 基本验证：检查是否像 SSH 私钥
    if (!content.includes("PRIVATE KEY") && !content.includes("BEGIN") && !content.includes("ssh-")) {
      return apiError("文件内容不像有效的 SSH 密钥");
    }

    // 存储到 system_configs 表（key_content 字段）
    const configKey = "bt_ssh_key_content";
    const existing = await prisma.system_configs.findFirst({
      where: { config_key: configKey, is_deleted: 0 },
    });

    if (existing) {
      await prisma.system_configs.update({
        where: { id: existing.id },
        data: { config_value: content },
      });
    } else {
      await prisma.system_configs.create({
        data: {
          config_key: configKey,
          config_value: content,
          description: "SSH 密钥内容（上传的私钥文件）",
        },
      });
    }

    clearConfigCache();

    return apiSuccess({
      filename: file.name,
      size: file.size,
    }, "密钥文件已上传");
  } catch (err) {
    console.error("[ssh-key upload] error:", err);
    return apiError("上传失败: " + (err instanceof Error ? err.message : String(err)));
  }
});

// DELETE — 删除已上传的密钥
export const DELETE = withAdmin(async () => {
  const existing = await prisma.system_configs.findFirst({
    where: { config_key: "bt_ssh_key_content", is_deleted: 0 },
  });

  if (existing) {
    await prisma.system_configs.update({
      where: { id: existing.id },
      data: { config_value: null },
    });
    clearConfigCache();
  }

  return apiSuccess(null, "密钥已删除");
});
