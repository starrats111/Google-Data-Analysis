import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideHermesGate, hermesAliveMessage, hermesTakeoverNote } from "../src/lib/hermes-liveness";

const H = 3_600_000;
const NOW = new Date("2026-09-26T14:00:00+08:00");
const ago = (hours: number) => new Date(NOW.getTime() - hours * H);

describe("D-362 Hermes 托管门：主权只在 Hermes 还在行使时有效", () => {
  it("01 报案的真实现场：投放侧最后一次回推 9-21 15:43，已静默 118 小时 → 判死，放行", () => {
    // nginx access.log 取证：/api/hermes/campaign-state 最后命中 21/Sep/2026:15:43:01，
    // 之后五天为 0（活着时是 10 次/天）
    const gate = decideHermesGate(new Date("2026-09-21T15:43:01+08:00"), 24, "heartbeat", NOW);
    assert.equal(gate.alive, false);
    assert.ok(gate.silentHours !== null && gate.silentHours > 100);
  });

  it("Hermes 正常活着（刚回推过）→ 仍然拦，D-247 的原意不变", () => {
    assert.equal(decideHermesGate(ago(0.5), 24, "heartbeat", NOW).alive, true);
    assert.equal(decideHermesGate(ago(23.9), 24, "heartbeat", NOW).alive, true);
  });

  it("阈值是闭右开左：正好到阈值算死，避免边界上反复横跳", () => {
    assert.equal(decideHermesGate(ago(24), 24, "heartbeat", NOW).alive, false);
    assert.equal(decideHermesGate(ago(24.1), 24, "heartbeat", NOW).alive, false);
  });

  it("从没见过 Hermes（心跳与兜底都空）→ 判死。闩是它自己写的，一次心跳都没有不能拦着人停广告", () => {
    const gate = decideHermesGate(null, 24, "none", NOW);
    assert.equal(gate.alive, false);
    assert.equal(gate.silentHours, null);
  });

  it("窗口可调：6 小时收紧、48 小时放宽，同一时刻结论跟着变（参数在 system_configs）", () => {
    assert.equal(decideHermesGate(ago(12), 6, "heartbeat", NOW).alive, false);
    assert.equal(decideHermesGate(ago(12), 24, "heartbeat", NOW).alive, true);
    assert.equal(decideHermesGate(ago(30), 48, "heartbeat", NOW).alive, true);
  });

  it("拒绝文案必须带上「凭什么说它活着」——否则用户只看到一句永远不变的托管提示", () => {
    const gate = decideHermesGate(ago(2), 24, "heartbeat", NOW);
    const msg = hermesAliveMessage(gate, "toggle");
    assert.ok(msg.includes("状态主权归 Hermes"));
    assert.ok(msg.includes("2 小时前"));
    assert.ok(msg.includes("判死阈值 24 小时"));
  });

  it("接管文案必须带上静默时长与上次回推时刻，让同一个按钮昨天报错今天放行这件事有据可查", () => {
    const note = hermesTakeoverNote(decideHermesGate(ago(118.3), 24, "heartbeat", NOW));
    assert.ok(note.includes("118.3"));
    assert.ok(note.includes("2026-09-21"));
    assert.ok(note.includes("D-362"));
  });
});
