/**
 * D-199 共享工具：联盟账号连接的展示标签。
 *
 * 背景：下拉框原来只显示 `account_name`，而 `account_name` 是自由文本（人名、站点名、
 * 邮箱、带前导空格的字符串都有），同平台多个号常常同名。wj04 名下 8 条 PM 连接的
 * account_name 全是 "weilixia"，8 个选项肉眼无法区分，只能靠猜。
 *
 * 真正能区分的是 `account_index`（D-168 的持久化位次），它同时也是系列名平台段的序号
 * （`488-PM8-...` 里的 8）和用户口头沟通用的叫法（"我主要用 PM8"）。所以标签以编号打头。
 *
 * 唯一口径，前后端共用，避免各处自行拼接后再度漂移（D-194 的教训）。
 */
import { normalizePlatformCode } from "@/lib/constants";

export interface ConnectionLabelInput {
  platform: string;
  account_index?: number | null;
  account_name?: string | null;
}

/** 平台+位次，如 `PM8`；位次缺失时退化为纯平台码。 */
export function connectionCode(c: ConnectionLabelInput): string {
  const platform = normalizePlatformCode(c.platform || "");
  return c.account_index ? `${platform}${c.account_index}` : platform;
}

/**
 * 完整展示标签，如 `PM8 · weilixia`。
 * account_name 为空、或与编号重复（自动生成的名字就是 `PM8`）时只返回编号。
 */
export function connectionLabel(c: ConnectionLabelInput): string {
  const code = connectionCode(c);
  const name = (c.account_name || "").trim();
  if (!name || name === code || name === normalizePlatformCode(c.platform || "")) return code;
  return `${code} · ${name}`;
}

/** 下拉框排序：先平台，再位次，位次缺失的排最后。 */
export function compareConnections(a: ConnectionLabelInput, b: ConnectionLabelInput): number {
  const pa = normalizePlatformCode(a.platform || "");
  const pb = normalizePlatformCode(b.platform || "");
  if (pa !== pb) return pa < pb ? -1 : 1;
  return (a.account_index ?? Number.MAX_SAFE_INTEGER) - (b.account_index ?? Number.MAX_SAFE_INTEGER);
}
