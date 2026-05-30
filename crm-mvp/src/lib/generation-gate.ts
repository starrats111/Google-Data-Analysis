/**
 * D-063：整条广告生成的进程级并发闸
 *
 * 背景（见 设计方案.md D-063 实证）：
 *   Puppeteer 信号量（puppeteer-semaphore.ts）只把"同时打开的 Chromium 浏览器"限到 3，
 *   但多条广告同时点"一键生成"时，每条都要抢 主爬 + sitelinks 兜底 + 图片 等多个 slot，
 *   瞬时把 3 个 slot 打爆 → 后到的主爬 60s 等不到 slot 超时返回 null → UI 显示"爬取失败"，
 *   同时 2C/3.7G 服务器 load 飙到 8-10、iowait 30%+、mariadb 查询挂起。
 *
 * 本闸在"整条生成"（types 含 core 的请求）入口处夹一个全进程信号量：
 *   - 同一时刻最多 MAX_CONCURRENT_GENERATIONS 条整条生成并行，多的 FIFO 排队；
 *   - 排队期间调用方可经 onQueued 回调向前端推"排队中"提示（SSE 心跳保持连接不断）；
 *   - 与 Puppeteer 信号量是两层闸：本闸控"几条生成同时跑"，Puppeteer 闸控"几个浏览器同时开"。
 *
 * 环境变量 GENERATION_GATE_OFF=1 可一键 bypass（用于快速回滚定位）。
 */

const MAX_CONCURRENT_GENERATIONS = 2;

let _active = 0;
const _waiters: Array<() => void> = [];

function isDisabled(): boolean {
  return process.env.GENERATION_GATE_OFF === "1";
}

/**
 * 申请一个"整条生成"slot。
 *
 * @param opts.onQueued 当本次请求未能立即拿到 slot、进入排队时回调一次，参数为排队位次（1 = 队首）。
 * @param opts.timeoutMs 最长排队等待（默认 180000ms / 3 分钟）。超时抛 GENERATION_SLOT_TIMEOUT，
 *                       调用方应 catch 并提示用户稍后重试。传 0 表示无限等待。
 * @returns release 函数（必须在 finally 中调用，且仅生效一次）。
 */
export async function acquireGenerationSlot(opts?: {
  onQueued?: (position: number) => void;
  timeoutMs?: number;
}): Promise<() => void> {
  if (isDisabled()) {
    return () => {};
  }

  if (_active < MAX_CONCURRENT_GENERATIONS) {
    _active++;
    return makeReleaser();
  }

  // 需要排队
  const position = _waiters.length + 1;
  try {
    opts?.onQueued?.(position);
  } catch {
    /* 通知失败不影响排队 */
  }

  const timeoutMs = opts?.timeoutMs ?? 180000;
  return new Promise<() => void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onReady = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      _active++;
      resolve(makeReleaser());
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = _waiters.indexOf(onReady);
        if (idx >= 0) _waiters.splice(idx, 1);
        const err = new Error(
          `Generation slot timeout after ${timeoutMs}ms (active=${_active}/${MAX_CONCURRENT_GENERATIONS}, queued=${_waiters.length})`,
        );
        (err as Error & { code?: string }).code = "GENERATION_SLOT_TIMEOUT";
        reject(err);
      }, timeoutMs);
    }

    _waiters.push(onReady);
  });
}

function makeReleaser(): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (isDisabled()) return;
    _active = Math.max(0, _active - 1);
    if (_waiters.length > 0 && _active < MAX_CONCURRENT_GENERATIONS) {
      const next = _waiters.shift()!;
      next(); // onReady 内部自增 _active
    }
  };
}

/** 仅供诊断/日志用，勿用于业务分支。 */
export function generationGateStats(): {
  active: number;
  queued: number;
  max: number;
  disabled: boolean;
} {
  return {
    active: _active,
    queued: _waiters.length,
    max: MAX_CONCURRENT_GENERATIONS,
    disabled: isDisabled(),
  };
}
