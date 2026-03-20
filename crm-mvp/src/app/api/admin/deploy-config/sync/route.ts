/**
 * 从数据分析平台同步部署配置到 CRM
 * 调用后端 /api/deploy-config 接口，拉取 SSH/GitHub/CF 配置并保存到 system_configs 表
 */
import { apiSuccess, apiError } from "@/lib/constants";
import { withAdmin } from "@/lib/api-handler";
import { getBackendConfig, clearConfigCache } from "@/lib/system-config";
import prisma from "@/lib/prisma";

const KEY_DESCRIPTIONS: Record<string, string> = {
  bt_ssh_host: "宝塔服务器 IP",
  bt_ssh_port: "SSH 端口",
  bt_ssh_user: "SSH 用户名",
  bt_ssh_password: "SSH 密码",
  bt_ssh_key_path: "SSH 密钥路径",
  bt_site_root: "网站根目录",
  github_token: "GitHub Token",
  github_org: "GitHub 组织/用户名",
  cf_token: "Cloudflare API Token",
  bt_server_ip: "宝塔服务器公网 IP",
};

// POST — 从数据分析平台后端拉取配置并保存到 CRM
export const POST = withAdmin(async () => {
  const backend = await getBackendConfig();
  if (!backend.apiUrl) {
    return apiError("请先在系统参数中设置后端 API 地址");
  }

  try {
    // 先登录获取 token（使用后端 API Token 或直接调用）
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (backend.apiToken) {
      headers["Authorization"] = `Bearer ${backend.apiToken}`;
    }

    const res = await fetch(`${backend.apiUrl}/api/deploy-config`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return apiError(`数据分析平台返回错误 (${res.status}): ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    if (!data.success || !data.config) {
      return apiError("数据分析平台返回数据格式异常");
    }

    const config = data.config as Record<string, string>;

    // 保存到 CRM 的 system_configs 表
    let savedCount = 0;
    for (const [key, value] of Object.entries(config)) {
      if (!value) continue; // 跳过空值

      const existing = await prisma.system_configs.findFirst({
        where: { config_key: key, is_deleted: 0 },
      });

      if (existing) {
        // 只在值不同时更新
        if (existing.config_value !== value) {
          await prisma.system_configs.update({
            where: { id: existing.id },
            data: { config_value: value },
          });
          savedCount++;
        }
      } else {
        await prisma.system_configs.create({
          data: {
            config_key: key,
            config_value: value,
            description: KEY_DESCRIPTIONS[key] || null,
          },
        });
        savedCount++;
      }
    }

    clearConfigCache();

    return apiSuccess({
      synced: savedCount,
      source: data.source || "backend_env",
      config,
    }, `已从数据分析平台同步 ${savedCount} 项配置`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("fetch") || msg.includes("ECONNREFUSED") || msg.includes("timeout")) {
      return apiError("无法连接数据分析平台后端，请检查后端 API 地址是否正确且服务已启动");
    }
    return apiError("同步失败: " + msg);
  }
});
