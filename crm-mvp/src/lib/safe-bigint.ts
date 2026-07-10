/**
 * D-163⑯：安全解析请求里的 ID → BigInt。
 * 直接 BigInt(id) 遇到非数字会抛 SyntaxError，让接口 500；统一改为返回 null 由调用方给 400 提示。
 */
export function toBigIntId(val: unknown): bigint | null {
  if (val === undefined || val === null || val === "") return null;
  const s = typeof val === "number" && Number.isInteger(val) ? String(val) : String(val).trim();
  if (!/^\d+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}
