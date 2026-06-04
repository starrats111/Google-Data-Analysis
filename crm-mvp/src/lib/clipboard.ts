/**
 * BUG-01 复制加固（设计方案.md §四点五）
 *
 * 统一复制入口：优先 navigator.clipboard（需安全上下文 https + 已聚焦），
 * 失败 / 非安全上下文时回退到隐藏 textarea + execCommand('copy')，
 * 保证「任何情况下都能复制完整内容」，避免出现复制成功但内容缺失/截断的假象。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* 落到 execCommand 兜底 */
    }
  }

  if (typeof document === "undefined") return false;

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/** 截断预览，供复制成功提示当场核对内容是否完整 */
export function previewText(text: string, max = 60): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
