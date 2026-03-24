import prisma from "@/lib/prisma";
import { clearConfigCache, getSystemConfig } from "@/lib/system-config";

export const TOKEN_POOL_STORAGE_KEY = "deploy_credentials_json";

export interface GitHubTokenEntry {
  id: string;
  label: string;
  org: string;
  token: string;
}

export interface CFTokenEntry {
  id: string;
  label: string;
  token: string;
}

export interface TokenPool {
  github_tokens: GitHubTokenEntry[];
  cf_tokens: CFTokenEntry[];
  bt_server_ip: string;
}

function normalizeGitHubToken(input: Partial<GitHubTokenEntry> | null, idx = 0): GitHubTokenEntry {
  return {
    id: input?.id?.trim() || `gh_${Date.now()}_${idx}`,
    label: input?.label?.trim() || `GitHub Token ${idx + 1}`,
    org: input?.org?.trim() || "",
    token: typeof input?.token === "string" ? input.token : "",
  };
}

function normalizeCFToken(input: Partial<CFTokenEntry> | null, idx = 0): CFTokenEntry {
  return {
    id: input?.id?.trim() || `cf_${Date.now()}_${idx}`,
    label: input?.label?.trim() || `CF Token ${idx + 1}`,
    token: typeof input?.token === "string" ? input.token : "",
  };
}

export function sanitizeTokenPool(input: unknown): TokenPool {
  if (!input || typeof input !== "object") {
    return { github_tokens: [], cf_tokens: [], bt_server_ip: "" };
  }

  const raw = input as Record<string, unknown>;

  if (Array.isArray(raw.github_tokens) || Array.isArray(raw.cf_tokens)) {
    return {
      github_tokens: Array.isArray(raw.github_tokens)
        ? raw.github_tokens.map((item, i) => normalizeGitHubToken(item ?? {}, i))
        : [],
      cf_tokens: Array.isArray(raw.cf_tokens)
        ? raw.cf_tokens.map((item, i) => normalizeCFToken(item ?? {}, i))
        : [],
      bt_server_ip: typeof raw.bt_server_ip === "string" ? raw.bt_server_ip : "",
    };
  }

  return { github_tokens: [], cf_tokens: [], bt_server_ip: "" };
}

interface LegacyTokenUser {
  id?: string;
  user_name?: string;
  name?: string;
  github_token?: string;
  github_org?: string;
  cf_token?: string;
  bt_server_ip?: string;
}

function convertLegacyArray(arr: LegacyTokenUser[]): TokenPool {
  const ghTokens: GitHubTokenEntry[] = [];
  const cfTokens: CFTokenEntry[] = [];
  const cfSeen = new Set<string>();
  let btIp = "";

  for (const u of arr) {
    if (u.github_token) {
      ghTokens.push({
        id: `gh-${u.id || ghTokens.length}`,
        label: u.user_name || u.name || u.github_org || `GitHub ${ghTokens.length + 1}`,
        org: u.github_org || "",
        token: u.github_token,
      });
    }
    if (u.cf_token && !cfSeen.has(u.cf_token)) {
      cfSeen.add(u.cf_token);
      cfTokens.push({
        id: `cf-${u.id || cfTokens.length}`,
        label: u.user_name || u.name || `CF ${cfTokens.length + 1}`,
        token: u.cf_token,
      });
    }
    if (u.bt_server_ip && !btIp) btIp = u.bt_server_ip;
  }

  return { github_tokens: ghTokens, cf_tokens: cfTokens, bt_server_ip: btIp };
}

export async function getTokenPool(): Promise<TokenPool> {
  const raw = await getSystemConfig(TOKEN_POOL_STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed.github_tokens || parsed.cf_tokens)) {
        return sanitizeTokenPool(parsed);
      }
      if (Array.isArray(parsed)) {
        return convertLegacyArray(parsed);
      }
    } catch { /* fall through */ }
  }

  const [github_token, github_org, cf_token, bt_server_ip] = await Promise.all([
    getSystemConfig("github_token"),
    getSystemConfig("github_org"),
    getSystemConfig("cf_token"),
    getSystemConfig("bt_server_ip"),
  ]);

  const pool: TokenPool = { github_tokens: [], cf_tokens: [], bt_server_ip: bt_server_ip || "" };
  if (github_token) {
    pool.github_tokens.push({ id: "legacy-gh", label: github_org || "默认", org: github_org || "", token: github_token });
  }
  if (cf_token) {
    pool.cf_tokens.push({ id: "legacy-cf", label: "默认 CF Token", token: cf_token });
  }
  return pool;
}

export async function saveTokenPool(pool: unknown): Promise<TokenPool> {
  const sanitized = sanitizeTokenPool(pool);
  const payload = JSON.stringify(sanitized);

  const existing = await prisma.system_configs.findFirst({
    where: { config_key: TOKEN_POOL_STORAGE_KEY, is_deleted: 0 },
  });

  if (existing) {
    await prisma.system_configs.update({
      where: { id: existing.id },
      data: { config_value: payload, description: "Token 池（GitHub + CF，JSON）" },
    });
  } else {
    await prisma.system_configs.create({
      data: { config_key: TOKEN_POOL_STORAGE_KEY, config_value: payload, description: "Token 池（GitHub + CF，JSON）" },
    });
  }

  clearConfigCache();
  return sanitized;
}

// ─── 自动匹配 ───

export function findGitHubToken(pool: TokenPool, orgOrRef: string): GitHubTokenEntry | undefined {
  if (pool.github_tokens.length === 0) return undefined;
  if (!orgOrRef) return pool.github_tokens[0];

  const lower = orgOrRef.toLowerCase();

  const exact = pool.github_tokens.find((t) => t.org.toLowerCase() === lower);
  if (exact) return exact;

  const partial = pool.github_tokens.find((t) => t.org && lower.includes(t.org.toLowerCase()));
  if (partial) return partial;

  return pool.github_tokens[0];
}

export async function findCFTokenForDomain(pool: TokenPool, domain: string): Promise<CFTokenEntry | undefined> {
  if (pool.cf_tokens.length === 0) return undefined;
  if (pool.cf_tokens.length === 1) return pool.cf_tokens[0];

  for (const entry of pool.cf_tokens) {
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${domain}`, {
        headers: { Authorization: `Bearer ${entry.token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      const data = (await res.json()) as { result?: { id: string }[] };
      if (data.result && data.result.length > 0) {
        return entry;
      }
    } catch { /* try next */ }
  }

  return pool.cf_tokens[0];
}
