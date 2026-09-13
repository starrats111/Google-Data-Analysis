/**
 * 事件循环滞后采样 —— 判定「超时结论是否可信」的统一依据。
 *
 * 背景（同一根因的第三次复现）：
 *   - D-220（connection-health.ts:22）：1.67GB 进 swap，事件循环冻结 → undici 10s 建连
 *     计时器被误触发，进程内判「连不上」，同机 curl 却正常。
 *   - eliandelm 事故：checkProxyEgress 的 5s 探活在代理实测 1.0-1.8s 时超时，
 *     被日志写成「出口国不符」，可用代理被丢弃。
 *   - meyercanada.ca 事故（2026-09-12）：落地页 D-050 硬卡报 timeout/status=0，
 *     而同机 curl HEAD/GET 全部 200、0.15-0.44s；`--renderer-process-limit=1` 缺失
 *     使 3 个 Puppeteer slot 长成 19 个 chrome 进程，CPU pressure some=52%。
 *
 * 共同机制：`AbortSignal.timeout` / `setTimeout` 度量的是**墙钟**，不是「对方没响应」。
 * 进程被抢占时，定时器在网络请求还没拿到 CPU 前就已到期——超时不代表目标不可达。
 *
 * 用法：在一段网络探测前后夹住采样，拿到最大滞后；超过阈值时，该段的
 * timeout / network_error 结论不可作为「目标不可达」的证据。
 *
 *   const stop = startEventLoopLagSampler();
 *   const r = await probe();
 *   const { lagMs, starved } = stop();
 *   if (!r.ok && starved) { // 结论不可信，重探或放行
 */

/** 采样间隔 ms */
const SAMPLE_INTERVAL_MS = 100;

/**
 * 事件循环滞后阈值 ms。超过说明进程在该时段被显著抢占，定时器触发时机不可信。
 *
 * 取 1500ms 的依据：空闲进程实测 max lag 2ms（同机 node 5s 采样）；而事故时段
 * next-server 占 50% CPU、19 个 chrome 争抢 2 核，滞后进入秒级。1500ms 足以把
 * 「正常抖动」与「被抢占」分开，又远小于最短探测超时 8000ms，不会把真超时误判成虚假。
 */
export const STARVATION_LAG_MS = 1500;

export interface LagSample {
  /** 采样窗口内观测到的最大事件循环滞后 ms */
  lagMs: number;
  /** 是否被显著抢占（lagMs >= STARVATION_LAG_MS）→ 超时结论不可信 */
  starved: boolean;
}

/**
 * 开始采样事件循环滞后。返回 stop()，调用后停止采样并给出结果。
 *
 * 定时器 unref，不阻止进程退出；stop() 幂等。
 */
export function startEventLoopLagSampler(): () => LagSample {
  let maxLag = 0;
  let last = Date.now();
  let stopped = false;

  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - SAMPLE_INTERVAL_MS;
    if (lag > maxLag) maxLag = lag;
    last = now;
  }, SAMPLE_INTERVAL_MS);

  // 不让采样器把进程钉住（脚本/一次性任务场景）
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }

  return () => {
    if (!stopped) {
      clearInterval(timer);
      stopped = true;
    }
    return { lagMs: maxLag, starved: maxLag >= STARVATION_LAG_MS };
  };
}
