/**
 * 系统配置工具 — 从 system_configs 表读取配置
 * 带内存缓存，避免每次 SSH 操作都查库
 */
import prisma from "@/lib/prisma";

// 缓存：key → { value, ts }
const cache = new Map<string, { value: string | null; ts: number }>();
const CACHE_TTL = 60_000; // 60 秒缓存

/**
 * 获取单个系统配置值
 */
export async function getSystemConfig(key: string): Promise<string | null> {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.value;
  }

  const row = await prisma.system_configs.findFirst({
    where: { config_key: key, is_deleted: 0 },
    select: { config_value: true },
  });

  const value = row?.config_value ?? null;
  cache.set(key, { value, ts: Date.now() });
  return value;
}

/**
 * 批量获取系统配置（前缀匹配）
 */
export async function getSystemConfigsByPrefix(prefix: string): Promise<Record<string, string>> {
  const rows = await prisma.system_configs.findMany({
    where: {
      config_key: { startsWith: prefix },
      is_deleted: 0,
    },
    select: { config_key: true, config_value: true },
  });

  const result: Record<string, string> = {};
  for (const row of rows) {
    const value = row.config_value ?? "";
    result[row.config_key] = value;
    cache.set(row.config_key, { value, ts: Date.now() });
  }
  return result;
}

/**
 * 清除缓存（配置更新后调用）
 */
export function clearConfigCache(key?: string) {
  if (key) {
    cache.delete(key);
  } else {
    cache.clear();
  }
}

// ─── 宝塔 SSH 配置 key 常量 ───
export const BT_CONFIG_KEYS = {
  HOST: "bt_ssh_host",
  PORT: "bt_ssh_port",
  USER: "bt_ssh_user",
  PASSWORD: "bt_ssh_password",
  KEY_PATH: "bt_ssh_key_path",
  KEY_CONTENT: "bt_ssh_key_content",  // 上传的密钥文件内容
  SITE_ROOT: "bt_site_root",
} as const;

// ─── 后端服务器配置 key 常量 ───
export const BACKEND_CONFIG_KEYS = {
  API_URL: "backend_api_url",
  API_TOKEN: "backend_api_token",
} as const;

// ─── MySQL 数据库配置 key 常量 ───
export const MYSQL_CONFIG_KEYS = {
  HOST: "mysql_host",
  PORT: "mysql_port",
  USER: "mysql_user",
  PASSWORD: "mysql_password",
  DATABASE: "mysql_database",
  SHADOW_DATABASE: "mysql_shadow_database",
} as const;

// ─── Google Sheets 配置 key 常量 ───
export const GOOGLE_SHEETS_CONFIG_KEYS = {
  SA_JSON: "google_sheets_sa_json",
} as const;

// ─── 配置分组定义（前端表单渲染用）───
export interface ConfigField {
  key: string;
  label: string;
  placeholder: string;
  required?: boolean;
  isPassword?: boolean;
  isTextarea?: boolean;
  type?: "text" | "password" | "number";
}

export const CONFIG_GROUPS = {
  backend: {
    title: "后端服务器",
    icon: "ApiOutlined",
    description: "数据分析平台后端 API 地址，用于站点管理、文章发布等服务调用。",
    prefix: "backend_",
    fields: [
      { key: "backend_api_url", label: "后端 API 地址", placeholder: "如：http://localhost:8000", required: true },
      { key: "backend_api_token", label: "API Token", placeholder: "后端认证 Token", isPassword: true },
    ] as ConfigField[],
  },
  mysql: {
    title: "MySQL 数据库",
    icon: "DatabaseOutlined",
    description: "CRM 系统 MySQL 数据库连接参数，用于初始化脚本和数据迁移。",
    prefix: "mysql_",
    fields: [
      { key: "mysql_host", label: "主机地址", placeholder: "如：localhost 或 127.0.0.1", required: true },
      { key: "mysql_port", label: "端口", placeholder: "3306", type: "number" },
      { key: "mysql_user", label: "用户名", placeholder: "数据库用户名", required: true },
      { key: "mysql_password", label: "密码", placeholder: "数据库密码", isPassword: true as const },
      { key: "mysql_database", label: "数据库名", placeholder: "google-data-analysis", required: true },
      { key: "mysql_shadow_database", label: "影子库名", placeholder: "google-data-analysis_shadow" },
    ] as ConfigField[],
  },
  google_sheets: {
    title: "Google Sheets 服务账号",
    icon: "GoogleOutlined",
    description: "用于访问需要邮箱授权的 Google Sheet（违规/推荐商家名单）。将 Service Account JSON 粘贴到下方，并将 Sheet 共享给该服务账号邮箱。",
    prefix: "google_sheets_",
    fields: [
      { key: "google_sheets_sa_json", label: "Service Account JSON", placeholder: "粘贴 Google Cloud Service Account 密钥 JSON 全文（与 MCC 使用同一个即可）", required: true, isTextarea: true },
    ] as ConfigField[],
  },
} as const;

// 所有配置 key 的描述映射（用于 upsert 时写入 description）
export const CONFIG_KEY_DESCRIPTIONS: Record<string, string> = {};
for (const group of Object.values(CONFIG_GROUPS)) {
  for (const field of group.fields) {
    CONFIG_KEY_DESCRIPTIONS[field.key] = field.label;
  }
}

/**
 * 获取宝塔 SSH 配置
 */
export async function getBtSshConfig() {
  const configs = await getSystemConfigsByPrefix("bt_");
  return {
    host: configs[BT_CONFIG_KEYS.HOST] || "",
    port: parseInt(configs[BT_CONFIG_KEYS.PORT] || "22"),
    username: configs[BT_CONFIG_KEYS.USER] || "ubuntu",
    password: configs[BT_CONFIG_KEYS.PASSWORD] || undefined,
    keyPath: configs[BT_CONFIG_KEYS.KEY_PATH] || undefined,
    keyContent: configs[BT_CONFIG_KEYS.KEY_CONTENT] || undefined,  // 上传的密钥内容
    siteRoot: configs[BT_CONFIG_KEYS.SITE_ROOT] || "/www/wwwroot",
  };
}

/**
 * 获取后端服务器配置
 */
export async function getBackendConfig() {
  const configs = await getSystemConfigsByPrefix("backend_");
  return {
    apiUrl: configs[BACKEND_CONFIG_KEYS.API_URL] || "",
    apiToken: configs[BACKEND_CONFIG_KEYS.API_TOKEN] || "",
  };
}

/**
 * 获取 MySQL 数据库配置
 */
export async function getMysqlConfig() {
  const configs = await getSystemConfigsByPrefix("mysql_");
  return {
    host: configs[MYSQL_CONFIG_KEYS.HOST] || "localhost",
    port: parseInt(configs[MYSQL_CONFIG_KEYS.PORT] || "3306"),
    user: configs[MYSQL_CONFIG_KEYS.USER] || "",
    password: configs[MYSQL_CONFIG_KEYS.PASSWORD] || "",
    database: configs[MYSQL_CONFIG_KEYS.DATABASE] || "google-data-analysis",
    shadowDatabase: configs[MYSQL_CONFIG_KEYS.SHADOW_DATABASE] || "google-data-analysis_shadow",
  };
}

/**
 * 获取 Google Sheets Service Account JSON
 */
export async function getGoogleSheetsSaJson(): Promise<string | null> {
  return getSystemConfig(GOOGLE_SHEETS_CONFIG_KEYS.SA_JSON);
}
