/**
 * D-041 / Policy Hub — Google Ads API 错误深度解析器
 *
 * 升级自 client.ts/parseGoogleAdsErrors（保留旧函数兼容）：
 *   1. 深入解析 details.policyViolationDetails（含 externalPolicyName / key.policyName / violatingText / isExemptible）
 *   2. fieldPath 可读化（mutate_operations[5] > ad > headlines[3] → "标题3"）
 *   3. 级联失败统一过滤（"-2" / "-3" / 数字临时资源名）
 *   4. 输出结构化 ParsedPolicyResult[]，可直接写入 policy_violations 表
 *   5. 整体可读消息生成（替代 client.ts/formatGoogleAdsErrorMessage 的中文输出）
 */

import { mapToPolicyCategory, type PolicyCategoryEntry } from "./policy-categories";

/** 单条政策违规结构化结果 */
export interface ParsedPolicyResult {
  /** Google Ads errorCode（如 "policyViolationError:POLICY_ERROR"） */
  errorCode: string;
  /** Google Ads message 原文 */
  message: string;
  /** policyViolationDetails.externalPolicyName，如 "Trademarks" */
  externalPolicyName: string | null;
  /** policyViolationDetails.externalPolicyDescription */
  externalPolicyDescription: string | null;
  /** policyViolationDetails.key.policyName，如 "trademark_in_ad_text" */
  policyName: string | null;
  /** 违规具体文本（如 "BLACK+DECKER"） */
  violatingText: string | null;
  /** 是否可豁免（提交申诉机会） */
  isExemptible: boolean;
  /** trigger 原始值（可能与 violatingText 重复或为空） */
  trigger: string | null;
  /** fieldPath 原始路径串（如 "mutate_operations[5] > ad_group_ad > create > ad > headlines[3]"） */
  fieldPath: string | null;
  /** fieldPath 可读化（如 "标题3" / "描述2" / "Sitelink desc1" / "致电扩展电话"） */
  readableField: string | null;
  /** mutate_operations 顶层 index（用于 submit/route.ts 移除违规操作重试） */
  operationIndex: number | null;
  /** 4 大类映射结果（含中文化 + 修复建议 + 政策原文 URL） */
  category: PolicyCategoryEntry;
  /** 是否为级联失败（"-2"/"-3" 这种由其他真错误连带触发的占位） */
  isCascade: boolean;
}

/** 整体解析结果 */
export interface ParsedPolicyError {
  /** 全部条目（含级联） */
  all: ParsedPolicyResult[];
  /** 排除级联后的真实违规（用于展示给员工 + 写表） */
  primary: ParsedPolicyResult[];
  /** 整体可读中文消息（员工直接看的描述） */
  readableMessage: string;
  /** 是否含 Policy 类违规（与 OPERATION_NOT_PERMITTED 区分） */
  hasPolicyViolation: boolean;
  /** 是否含账户上下文不支持错误（需自动切换 CID） */
  hasContextError: boolean;
  /** 原始错误体（截断 3000 字符） */
  rawBody: string;
}

const CASCADE_TRIGGER_RE = /^-?\d+$/;

/**
 * fieldPath 可读化：把 Google Ads API 的 fieldPathElements 翻译成员工能看懂的中文位置
 *
 * 输入示例：
 *   [{fieldName:"mutate_operations", index:5}, {fieldName:"ad_group_ad_operation"},
 *    {fieldName:"create"}, {fieldName:"ad"}, {fieldName:"responsive_search_ad"},
 *    {fieldName:"headlines", index:3}]
 *
 * 输出："标题4"（Google Ads 索引 0-based，员工习惯 1-based 显示）
 */
function readableFieldFromPath(elements: Array<{ fieldName: string; index?: number | null }>): string | null {
  if (!elements?.length) return null;
  // 找出最具体的叶子字段
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    const name = (el.fieldName || "").toLowerCase();
    const idx1 = el.index != null ? Number(el.index) + 1 : null; // 1-based 显示

    if (name === "headlines") return idx1 ? `标题${idx1}` : "标题";
    if (name === "descriptions") return idx1 ? `描述${idx1}` : "描述";
    if (name === "path1" || name === "path2") return `Display URL 路径${name.slice(-1)}`;
    if (name === "final_url" || name === "final_urls") return "Final URL";
    if (name === "tracking_url_template") return "跟踪模板";
    if (name === "url_custom_parameters") return "自定义参数";

    if (name === "sitelink_asset" || name === "sitelinkasset") return "Sitelink 资源";
    if (name === "callout_asset" || name === "calloutasset") return "Callout 标注扩展";
    if (name === "structured_snippet_asset") return "Structured Snippet 结构化摘要";
    if (name === "promotion_asset") return "Promotion 促销扩展";
    if (name === "call_asset") return "Call 致电扩展";
    if (name === "image_asset") return "Image 图片资源";
    if (name === "callout_text" || name === "calloutText") return "Callout 文本";
    if (name === "link_text" || name === "linkText") return "Sitelink 标题";
    if (name === "description1" || name === "description_1") return "Sitelink desc1";
    if (name === "description2" || name === "description_2") return "Sitelink desc2";

    if (name === "keyword") return "关键词";
    if (name === "text" && i > 0 && elements[i - 1]?.fieldName === "keyword") return "关键词文本";

    if (name === "campaign") return "广告系列";
    if (name === "ad_group" || name === "adgroup") return "广告组";
    if (name === "phone_number" || name === "phoneNumber") return "电话号码";
  }

  // 兜底：返回原始路径
  return elements
    .filter((e) => e.fieldName !== "mutate_operations" && e.fieldName !== "create" && e.fieldName !== "operation")
    .map((e) => (e.index != null ? `${e.fieldName}[${e.index}]` : e.fieldName))
    .join(".");
}

/**
 * 主 API：解析 Google Ads API 返回的 raw error body
 *
 * @param errBody Google Ads REST API 错误响应原文 string（fetch 的 resp.text() 结果）
 * @returns 结构化解析结果
 */
export function parsePolicyError(errBody: string): ParsedPolicyError {
  const empty: ParsedPolicyError = {
    all: [],
    primary: [],
    readableMessage: "",
    hasPolicyViolation: false,
    hasContextError: false,
    rawBody: errBody.slice(0, 3000),
  };
  if (!errBody) return empty;

  let errObj: Record<string, unknown> | null = null;
  try {
    const jsonStart = errBody.indexOf("{");
    const jsonEnd = errBody.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd <= jsonStart) return empty;
    errObj = JSON.parse(errBody.slice(jsonStart, jsonEnd + 1));
  } catch {
    return empty;
  }

  const root = (errObj?.error || errObj) as Record<string, unknown>;
  const details = (root?.details || []) as Array<Record<string, unknown>>;

  const results: ParsedPolicyResult[] = [];
  let hasContextErr = false;

  for (const detail of details) {
    const errors = (detail?.errors || []) as Array<Record<string, unknown>>;
    for (const e of errors) {
      // ── errorCode 字符串化 ──
      const codeObj = (e?.errorCode || {}) as Record<string, unknown>;
      const codeParts = Object.entries(codeObj).map(([k, v]) => `${k}:${v}`);
      const errorCode = codeParts.join(", ") || "UNKNOWN";

      // ── message ──
      const message = String(e?.message || "");

      // ── trigger ──
      const triggerObj = (e?.trigger || {}) as Record<string, unknown>;
      const triggerVal =
        triggerObj.stringValue
        || triggerObj.int64Value
        || triggerObj.floatValue
        || triggerObj.boolValue
        || null;
      const trigger = triggerVal != null ? String(triggerVal) : null;

      // ── isCascade 判断 ──
      const isCascade =
        !!trigger
        && CASCADE_TRIGGER_RE.test(trigger.trim())
        && message.includes("Resource was not found");

      // ── fieldPath 解析 ──
      const location = (e?.location || {}) as Record<string, unknown>;
      const fieldPathElementsRaw = (location?.fieldPathElements || []) as Array<Record<string, unknown>>;
      const fieldPathElements = fieldPathElementsRaw.map((el) => ({
        fieldName: String(el.fieldName || ""),
        index: el.index != null ? Number(el.index) : null,
      }));
      const fieldPath = fieldPathElements
        .map((el) => (el.index != null ? `${el.fieldName}[${el.index}]` : el.fieldName))
        .join(" > ");
      const readableField = readableFieldFromPath(fieldPathElements);

      // ── operationIndex（顶层 mutate_operations[N]） ──
      let operationIndex: number | null = null;
      for (const el of fieldPathElements) {
        if (el.fieldName === "mutate_operations" && el.index != null) {
          operationIndex = el.index;
          break;
        }
      }

      // ── policyViolationDetails 深度解析 ──
      const detailsField = (e?.details || {}) as Record<string, unknown>;
      const pvd = (detailsField?.policyViolationDetails || {}) as Record<string, unknown>;
      const pvdKey = (pvd?.key || {}) as Record<string, unknown>;
      const externalPolicyName = pvd?.externalPolicyName != null ? String(pvd.externalPolicyName) : null;
      const externalPolicyDescription =
        pvd?.externalPolicyDescription != null ? String(pvd.externalPolicyDescription) : null;
      const policyName = pvdKey?.policyName != null ? String(pvdKey.policyName) : null;
      const violatingText = pvdKey?.violatingText != null ? String(pvdKey.violatingText) : null;
      const isExemptible = pvd?.isExemptible === true;

      // ── 4 大类映射 ──
      const category = mapToPolicyCategory({
        policyName,
        externalPolicyName,
        errorCode,
        message,
      });

      // ── context error（自动切换 CID 用） ──
      if (
        errorCode.toLowerCase().includes("operationnotpermittedforcontext")
        || message.toLowerCase().includes("not allowed for the given context")
      ) {
        hasContextErr = true;
      }

      results.push({
        errorCode,
        message,
        externalPolicyName,
        externalPolicyDescription,
        policyName,
        violatingText,
        isExemptible,
        trigger,
        fieldPath: fieldPath || null,
        readableField,
        operationIndex,
        category,
        isCascade,
      });
    }
  }

  // primary = 排除级联后的真实违规
  const primary = results.filter((r) => !r.isCascade);
  const hasPolicyViolation = primary.some(
    (r) =>
      r.errorCode.toLowerCase().includes("policy")
      || r.errorCode.toLowerCase().includes("prohibited")
      || !!r.policyName,
  );

  // ── 生成员工可读消息 ──
  const readableMessage = buildReadableMessage(primary, hasContextErr, results.length - primary.length);

  return {
    all: results,
    primary,
    readableMessage,
    hasPolicyViolation,
    hasContextError: hasContextErr,
    rawBody: errBody.slice(0, 3000),
  };
}

/**
 * 把 ParsedPolicyResult[] 拼成员工友好的中文消息
 *
 * 示例输出：
 *   广告被 Google Ads 拒登（共 3 处违规）：
 *     • 商标侵权 — 标题4「Save on BLACK+DECKER favorites」含商标 "BLACK+DECKER"
 *       建议：改用类目词（Power Tools / Gear）替代品牌名，或申请 3rd-Party Authorization。
 *       政策原文：https://support.google.com/adspolicy/answer/6118
 *     • 不公平优势宣称 — 描述2「Award-Winning Trusted Brand」含 "Award-Winning"
 *       建议：改用具体可验证的事实。
 *       政策原文：https://support.google.com/adspolicy/answer/6020955
 *   （另有 12 个关联操作因上述错误级联失败，已忽略）
 */
function buildReadableMessage(
  primary: ParsedPolicyResult[],
  hasContextErr: boolean,
  cascadeCount: number,
): string {
  if (primary.length === 0 && cascadeCount === 0) return "";

  const lines: string[] = [];

  if (hasContextErr) {
    const contextItem = primary.find(
      (p) =>
        p.errorCode.toLowerCase().includes("operationnotpermittedforcontext")
        || p.message.toLowerCase().includes("not allowed for the given context"),
    );
    const channelInfo = contextItem?.trigger ? `「${contextItem.trigger}」` : "";
    lines.push(`当前 Google Ads 账户（CID）不支持创建该类型广告${channelInfo}，系统将自动尝试切换到其他可用账户。`);
    lines.push("如问题持续，请在「MCC 管理」中检查账户权限，或联系 Google Ads 支持开启该广告类型。");
    if (cascadeCount > 0) {
      lines.push(`（另有 ${cascadeCount} 个关联操作因账户限制同步失败，已忽略）`);
    }
    return lines.join("\n");
  }

  // 去重：同一 readableField + policyName 只展示一次
  const seenKeys = new Set<string>();
  const dedup: ParsedPolicyResult[] = [];
  for (const p of primary) {
    const k = `${p.readableField || "?"}::${p.policyName || p.errorCode}`;
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    dedup.push(p);
  }

  if (dedup.length === 0) {
    lines.push("Google Ads 拒登广告，但解析后未发现具体违规字段。请查看 raw body。");
    return lines.join("\n");
  }

  lines.push(`广告被 Google Ads 拒登（共 ${dedup.length} 处违规${cascadeCount > 0 ? ` + ${cascadeCount} 关联失败` : ""}）：`);

  for (const p of dedup) {
    const fieldPart = p.readableField ? `${p.readableField}` : "未知位置";
    const violatingPart = p.violatingText
      ? `「${p.violatingText}」`
      : p.trigger && !CASCADE_TRIGGER_RE.test(p.trigger)
      ? `「${p.trigger}」`
      : "";
    const desc = p.externalPolicyDescription || p.message || "";

    lines.push(`  • ${p.category.labelZh} — ${fieldPart}${violatingPart ? ` ${violatingPart}` : ""}${desc ? `（${desc}）` : ""}`);
    lines.push(`    建议：${p.category.suggestedFix}`);
    lines.push(`    政策原文：${p.category.officialUrl}`);
    if (p.isExemptible) {
      lines.push(`    可申诉：是（在 Google Ads 后台广告页点「申诉」按钮）`);
    }
  }

  return lines.join("\n");
}

/**
 * 兼容旧接口：返回 violatingIndices Set，用于 submit/route.ts L1149 移除违规操作后重试
 */
export function getViolatingOperationIndices(parsed: ParsedPolicyError): Set<number> {
  const set = new Set<number>();
  for (const p of parsed.primary) {
    if (p.operationIndex != null) set.add(p.operationIndex);
  }
  return set;
}
