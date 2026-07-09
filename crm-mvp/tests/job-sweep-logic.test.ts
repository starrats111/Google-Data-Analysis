import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyJobForSweep, isJobFresh, type SweepableJob } from "../src/lib/job-sweep-logic";

const NOW = Date.parse("2026-07-09T12:00:00Z");
const STALE_MS = 360_000; // 6min，与 submit-runner 一致
const MAX_ATTEMPT = 2;

function job(overrides: Partial<SweepableJob> = {}): SweepableJob {
  return {
    status: "running",
    attempt: 1,
    heartbeat_at: new Date(NOW - 10_000),
    created_at: new Date(NOW - 600_000),
    ...overrides,
  };
}

function classify(j: SweepableJob, inFlight = false) {
  return classifyJobForSweep(j, { now: NOW, staleMs: STALE_MS, maxAttempt: MAX_ATTEMPT, inFlight });
}

describe("isJobFresh", () => {
  it("心跳新鲜 → 新鲜", () => {
    assert.equal(isJobFresh(job(), NOW, STALE_MS), true);
  });

  it("无心跳但刚创建 → 新鲜（进程还没来得及打心跳）", () => {
    assert.equal(isJobFresh(job({ heartbeat_at: null, created_at: new Date(NOW - 5_000) }), NOW, STALE_MS), true);
  });

  it("心跳超时且创建已久 → 僵死", () => {
    assert.equal(
      isJobFresh(job({ heartbeat_at: new Date(NOW - 400_000), created_at: new Date(NOW - 3600_000) }), NOW, STALE_MS),
      false,
    );
  });
});

describe("classifyJobForSweep", () => {
  it("done/failed 状态不处理", () => {
    assert.equal(classify(job({ status: "done" })), "skip");
    assert.equal(classify(job({ status: "failed" })), "skip");
  });

  it("本进程正在跑（inFlight）勿动，即使心跳僵死", () => {
    assert.equal(classify(job({ heartbeat_at: new Date(NOW - 3600_000) }), true), "skip");
  });

  it("running 且心跳新鲜 → 活着，不动", () => {
    assert.equal(classify(job({ status: "running", heartbeat_at: new Date(NOW - 30_000) })), "skip");
  });

  it("running 且心跳僵死、未超尝试上限 → 重新入队", () => {
    assert.equal(
      classify(job({ status: "running", attempt: 1, heartbeat_at: new Date(NOW - 400_000) })),
      "requeue",
    );
  });

  it("running 且心跳僵死、已达尝试上限 → 判失败", () => {
    assert.equal(
      classify(job({ status: "running", attempt: MAX_ATTEMPT, heartbeat_at: new Date(NOW - 400_000) })),
      "fail",
    );
  });

  it("queued 且新鲜但从未被跑过（attempt=0）→ 掉队，立即入队", () => {
    assert.equal(
      classify(job({ status: "queued", attempt: 0, heartbeat_at: new Date(NOW - 30_000) })),
      "requeue",
    );
  });

  it("queued 且新鲜且已被跑过 → 等下一轮再判", () => {
    assert.equal(
      classify(job({ status: "queued", attempt: 1, heartbeat_at: new Date(NOW - 30_000) })),
      "skip",
    );
  });

  it("queued 僵死且超尝试上限 → 判失败", () => {
    assert.equal(
      classify(job({ status: "queued", attempt: 3, heartbeat_at: new Date(NOW - 3600_000) })),
      "fail",
    );
  });

  it("无心跳的 queued 用创建时间判僵死", () => {
    assert.equal(
      classify(job({ status: "queued", attempt: 1, heartbeat_at: null, created_at: new Date(NOW - 3600_000) })),
      "requeue",
    );
  });

  it("attempt 为 null 视为 0", () => {
    assert.equal(
      classify(job({ status: "queued", attempt: null, heartbeat_at: new Date(NOW - 3600_000) })),
      "requeue",
    );
  });
});
