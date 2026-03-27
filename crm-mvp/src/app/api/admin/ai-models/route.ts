import { NextRequest } from "next/server";
import { getAdminFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

/** 避免被静态化/缓存边缘行为影响管理 API */
export const dynamic = "force-dynamic";

const SCENE_MAX = 32;
const MODEL_NAME_MAX = 64;
const PRIORITY_MIN = 1;
const PRIORITY_MAX = 255;
const MAX_TOKENS_MIN = 256;
const MAX_TOKENS_MAX = 32768;

function safeBigInt(val: unknown, field: string): { ok: true; value: bigint } | { ok: false; message: string } {
  if (val === undefined || val === null || val === "") {
    return { ok: false, message: `${field} 不能为空` };
  }
  const s = typeof val === "number" && Number.isInteger(val) ? String(val) : String(val).trim();
  if (!/^\d+$/.test(s)) {
    return { ok: false, message: `${field} 须为有效正整数` };
  }
  try {
    return { ok: true, value: BigInt(s) };
  } catch {
    return { ok: false, message: `${field} 超出可表示范围` };
  }
}

function handlePrismaErr(e: unknown): string | null {
  if (e && typeof e === "object" && "code" in e) {
    const code = (e as { code: string }).code;
    if (code === "P2025") return "记录不存在或已删除";
  }
  return null;
}

function normalizeTemperature(v: unknown): number {
  if (v === undefined || v === null || v === "") return 0.7;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0.7;
  const clamped = Math.min(9.99, Math.max(0, n));
  return Math.round(clamped * 100) / 100;
}

function parseRequiredUInt(
  v: unknown,
  field: string,
  min: number,
  max: number,
): { ok: true; n: number } | { ok: false; message: string } {
  if (v === undefined || v === null || v === "") {
    return { ok: false, message: `${field} 不能为空` };
  }
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, message: `${field} 须为整数` };
  }
  if (n < min || n > max) {
    return { ok: false, message: `${field} 须在 ${min}~${max} 之间` };
  }
  return { ok: true, n };
}

export async function GET(req: NextRequest) {
  try {
    const admin = getAdminFromRequest(req);
    if (!admin) return apiError("未授权", 401);

    const configs = await prisma.ai_model_configs.findMany({
      where: { is_deleted: 0 },
      orderBy: [{ scene: "asc" }, { priority: "asc" }],
    });

    const providers = await prisma.ai_providers.findMany({
      where: { is_deleted: 0, status: "active" },
      select: { id: true, provider_name: true },
    });

    return apiSuccess(serializeData({ configs, providers }));
  } catch (e) {
    console.error("[admin/ai-models] GET", e);
    const hint = handlePrismaErr(e);
    return apiError(hint ?? "查询失败，请稍后重试", 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = getAdminFromRequest(req);
    if (!admin) return apiError("未授权", 401);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return apiError("请求体不是合法 JSON", 400);
    }

    const { scene, provider_id, model_name, max_tokens, temperature, priority } = body;
    if (!scene || !provider_id || !model_name) return apiError("场景、供应商和模型名称不能为空");

    const sceneStr = String(scene).trim();
    const modelStr = String(model_name).trim();
    if (!sceneStr || sceneStr.length > SCENE_MAX) {
      return apiError(`场景长度须在 1~${SCENE_MAX} 字符`);
    }
    if (!modelStr || modelStr.length > MODEL_NAME_MAX) {
      return apiError(`模型名称长度须在 1~${MODEL_NAME_MAX} 字符`);
    }

    const pid = safeBigInt(provider_id, "供应商 ID");
    if (!pid.ok) return apiError(pid.message);

    const pr = parseRequiredUInt(priority ?? 1, "优先级", PRIORITY_MIN, PRIORITY_MAX);
    if (!pr.ok) return apiError(pr.message);

    const mt = parseRequiredUInt(max_tokens ?? 4096, "Max Tokens", MAX_TOKENS_MIN, MAX_TOKENS_MAX);
    if (!mt.ok) return apiError(mt.message);

    const config = await prisma.ai_model_configs.create({
      data: {
        scene: sceneStr,
        provider_id: pid.value,
        model_name: modelStr,
        max_tokens: mt.n,
        temperature: normalizeTemperature(temperature),
        priority: pr.n,
      },
    });
    return apiSuccess(serializeData(config));
  } catch (e) {
    console.error("[admin/ai-models] POST", e);
    const hint = handlePrismaErr(e);
    return apiError(hint ?? "创建失败，请稍后重试", 500);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const admin = getAdminFromRequest(req);
    if (!admin) return apiError("未授权", 401);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return apiError("请求体不是合法 JSON", 400);
    }

    const { id, scene, provider_id, model_name, max_tokens, temperature, is_active, priority } = body;
    if (id === undefined || id === null || id === "") return apiError("缺少 ID");

    const idParsed = safeBigInt(id, "配置 ID");
    if (!idParsed.ok) return apiError(idParsed.message);

    const data: Record<string, unknown> = {};
    if (scene !== undefined) {
      const s = String(scene).trim();
      if (!s || s.length > SCENE_MAX) return apiError(`场景长度须在 1~${SCENE_MAX} 字符`);
      data.scene = s;
    }
    if (provider_id !== undefined) {
      const pid = safeBigInt(provider_id, "供应商 ID");
      if (!pid.ok) return apiError(pid.message);
      data.provider_id = pid.value;
    }
    if (model_name !== undefined) {
      const m = String(model_name).trim();
      if (!m || m.length > MODEL_NAME_MAX) return apiError(`模型名称长度须在 1~${MODEL_NAME_MAX} 字符`);
      data.model_name = m;
    }
    if (max_tokens !== undefined) {
      const mt = parseRequiredUInt(max_tokens, "Max Tokens", MAX_TOKENS_MIN, MAX_TOKENS_MAX);
      if (!mt.ok) return apiError(mt.message);
      data.max_tokens = mt.n;
    }
    if (temperature !== undefined) {
      data.temperature = normalizeTemperature(temperature);
    }
    if (is_active !== undefined) {
      const a = Number(is_active);
      if (a !== 0 && a !== 1) return apiError("启用状态须为 0 或 1");
      data.is_active = a;
    }
    if (priority !== undefined) {
      const pr = parseRequiredUInt(priority, "优先级", PRIORITY_MIN, PRIORITY_MAX);
      if (!pr.ok) return apiError(pr.message);
      data.priority = pr.n;
    }

    if (Object.keys(data).length === 0) {
      return apiError("无更新字段");
    }

    await prisma.ai_model_configs.update({ where: { id: idParsed.value }, data });
    return apiSuccess(null, "更新成功");
  } catch (e) {
    console.error("[admin/ai-models] PUT", e);
    const hint = handlePrismaErr(e);
    return apiError(hint ?? "更新失败，请稍后重试", 500);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const admin = getAdminFromRequest(req);
    if (!admin) return apiError("未授权", 401);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return apiError("请求体不是合法 JSON", 400);
    }

    const { id } = body;
    if (id === undefined || id === null || id === "") return apiError("缺少 ID");

    const idParsed = safeBigInt(id, "配置 ID");
    if (!idParsed.ok) return apiError(idParsed.message);

    await prisma.ai_model_configs.update({ where: { id: idParsed.value }, data: { is_deleted: 1 } });
    return apiSuccess(null, "删除成功");
  } catch (e) {
    console.error("[admin/ai-models] DELETE", e);
    const hint = handlePrismaErr(e);
    return apiError(hint ?? "删除失败，请稍后重试", 500);
  }
}
