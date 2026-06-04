/**
 * BUG-01 复制加固（设计方案.md §四点五）
 *
 * 统一复制入口：优先 navigator.clipboard（需安全上下文 https + 已聚焦），
 * 失败 / 非安全上下文时回退到 textarea + execCommand('copy')。
 *
 * 复现根因：当通过 http（如 IP:端口）访问时 window.isSecureContext=false，
 * 直接走 execCommand 兜底；而旧实现把 textarea 放在屏幕外（top:-9999px），
 * 部分浏览器下 execCommand('copy') 会「返回 true 但实际没复制」，导致剪贴板
 * 残留上一次的内容（看起来像复制了 token）。本次修复：textarea 放进视口内但
 * 视觉不可见，先 focus 再选中，复制后恢复原选区，确保兜底真正写入。
 */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;

  const selection = typeof window !== "undefined" ? window.getSelection() : null;
  const savedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  // 关键：放进视口内（top/left:0）而非屏幕外，否则部分浏览器复制为空
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.padding = "0";
  textarea.style.margin = "0";
  textarea.style.border = "none";
  textarea.style.outline = "none";
  textarea.style.boxShadow = "none";
  textarea.style.background = "transparent";
  textarea.style.opacity = "0";
  textarea.style.zIndex = "-1";
  document.body.appendChild(textarea);

  let ok = false;
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(textarea);
    // 恢复用户原本的选区，避免影响页面其它选择状态
    if (savedRange && selection) {
      selection.removeAllRanges();
      selection.addRange(savedRange);
    }
  }
  return ok;
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  if (
    typeof navigator !== "undefined"
    && navigator.clipboard
    && typeof navigator.clipboard.writeText === "function"
    && typeof window !== "undefined"
    && window.isSecureContext
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* 落到 execCommand 兜底 */
    }
  }

  return legacyCopy(text);
}

/** 截断预览，供复制成功提示当场核对内容是否完整 */
export function previewText(text: string, max = 60): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
