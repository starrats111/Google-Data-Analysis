/**
 * 从数据分析平台同步部署配置到 CRM
 */
import { apiSuccess, apiError } from "@/lib/constants";
import { withAdmin } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { getTokenPool, saveTokenPool, type TokenPool } from "@/lib/deploy-credentials";
import { clearConfigCache, getBackendConfig } from "@/lib/system-config";

const SERVER_KEY_DESCRIPTIONS: Record<string, string> = {
  bt_ssh_host: "宝塔服务器 IP",
  bt_ssh_port: "SSH 端口",
  bt_ssh_user: "SSH 用户名",
  bt_ssh_password: "SSH 密码",
  bt_ssh_key_path: "SSH 密钥路径",
  bt_ssh_key_content: "SSH 密钥内容（上传的私钥文件）",
  bt_site_root: "网站根目录",
};

const SERVER_KEYS = Object.keys(SERVER_KEY_DESCRIPTIONS);

export const POST = withAdmin(async () => {
  const backend = await getBackendConfig();
  if (!backend.apiUrl) {
    return apiError("请先在系统参数中设置后端 API 地址");
  }

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (backend.apiToken) {
      headers.Authorization = `Bearer ${backend.apiToken}`;
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

    let savedCount = 0;
    for (const key of SERVER_KEYS) {
      const value = config[key];
      if (!value) continue;

      const existing = await prisma.system_configs.findFirst({
        where: { config_key: key, is_deleted: 0 },
      });

      if (existing) {
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
            description: SERVER_KEY_DESCRIPTIONS[key] || null,
          },
        });
        savedCount++;
      }
    }

    const currentPool = await getTokenPool();

    const hasNewGH = config.github_token?.trim();
    const hasNewCF = config.cf_token?.trim();

    if (hasNewGH || hasNewCF) {
      const nextPool: TokenPool = { ...currentPool };

      if (hasNewGH) {
        const syncedGH = nextPool.github_tokens.find((t) => t.id === "backend-sync-gh");
        const entry = {
          id: "backend-sync-gh",
          label: config.github_org || "数据分析平台同步",
          org: config.github_org || "",
          token: config.github_token,
        };
        if (syncedGH) {
          Object.assign(syncedGH, entry);
        } else {
          nextPool.github_tokens.push(entry);
        }
      }

      if (hasNewCF) {
        const syncedCF = nextPool.cf_tokens.find((t) => t.id === "backend-sync-cf");
        const entry = {
          id: "backend-sync-cf",
          label: "数据分析平台同步",
          token: config.cf_token,
        };
        if (syncedCF) {
          Object.assign(syncedCF, entry);
        } else {
          nextPool.cf_tokens.push(entry);
        }
      }

      if (config.bt_server_ip) {
        nextPool.bt_server_ip = config.bt_server_ip;
      }

      await saveTokenPool(nextPool);
    }

    clearConfigCache();
    const finalPool = await getTokenPool();

    return apiSuccess(
      {
        synced: savedCount,
        source: data.source || "backend_env",
        config: {
          ...Object.fromEntries(SERVER_KEYS.map((key) => [key, config[key] || ""])),
          token_pool: finalPool,
        },
      },
      `已从数据分析平台同步 ${savedCount} 项服务器配置`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("fetch") || msg.includes("ECONNREFUSED") || msg.includes("timeout")) {
      return apiError("无法连接数据分析平台后端，请检查后端 API 地址是否正确且服务已启动");
    }
    return apiError("同步失败: " + msg);
  }
});
