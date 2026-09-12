/**
 * D-334 人工请求插队（2026-09-12，yz07「早上换链接一直超时」）。
 *
 * 事故形态：click-execute cron 每分钟 8 路并发压满 exchange 车道（上限 1-2），
 * 队列是纯 FIFO，员工在页面点「取链接」时那一条恒排在十余个 cron waiter 之后，
 * 30s 超时窗口内必然抢不到槽 → 前端弹「跟链超时，请重试或更换国家」，
 * 而换国家无用（同一条队列）。现场快照：active=2/3, exchangeQ=11。
 *
 * 为什么必须有测试：插队是**顺序**语义，坏掉是静默的——配额、计数、总并发全都正常，
 * 唯一的症状是「人工请求偶发超时」，跟机器慢、代理慢、链接坏完全无法区分，
 * 只会被再次归因成「链接失效」。
 *
 * 时段/星期一律用环境变量钉死，不依赖跑测试的时刻（与 slot-iso 用例同口径）。
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  acquireExchangeSlot,
  puppeteerSemaphoreStats,
  type SlotRelease,
} from "../src/lib/puppeteer-semaphore";

const held: SlotRelease[] = [];
function track(r: SlotRelease): SlotRelease {
  held.push(r);
  return r;
}

afterEach(() => {
  while (held.length) held.pop()!();
  delete process.env.EXCHANGE_ISOLATION_WORK_HOURS;
  delete process.env.EXCHANGE_ISOLATION_WORK_DAYS;
  delete process.env.EXCHANGE_SLOTS_PEAK;
  delete process.env.EXCHANGE_SLOTS_OFFPEAK;
  const s = puppeteerSemaphoreStats();
  assert.equal(s.active, 0, "用例结束应无残留占用");
  assert.equal(s.activeExchangeTotal, 0, "换链接计数应归零");
  assert.equal(s.queuedInteractive, 0, "人工排队计数应归零");
});

/** 钉成恒高峰（换链接并发 1）：最容易复现排队饥饿的档位 */
function peakAlways() {
  process.env.EXCHANGE_ISOLATION_WORK_HOURS = "0-24";
  process.env.EXCHANGE_ISOLATION_WORK_DAYS = "0-6";
  delete process.env.PUPPETEER_EXCHANGE_ISOLATION_OFF;
}

describe("D-334 exchange 车道人工插队", () => {
  test("人工请求排在已等待的 cron 请求之前被唤醒", async () => {
    peakAlways();
    const occupant = await acquireExchangeSlot(200).then(track);

    // 先让 3 个 cron 请求排队（模拟 click-execute 的并发投喂）
    const order: string[] = [];
    const cronPromises = [0, 1, 2].map((i) =>
      acquireExchangeSlot(3000).then((rel) => {
        order.push(`cron${i}`);
        return track(rel);
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(puppeteerSemaphoreStats().queuedExchange, 3, "3 个 cron 应在排队");

    // 人工请求最后到达，但应最先被唤醒
    const manualP = acquireExchangeSlot(3000, true).then((rel) => {
      order.push("manual");
      return track(rel);
    });
    await new Promise((r) => setTimeout(r, 30));
    const s = puppeteerSemaphoreStats();
    assert.equal(s.queuedExchange, 4, "队列里应有 4 个等待者");
    assert.equal(s.queuedInteractive, 1, "其中 1 个是人工请求");

    // 释放占用者，只够唤醒一个——必须是人工那个
    occupant();
    const manualRel = await manualP;
    assert.equal(order[0], "manual", `人工请求应最先被唤醒，实际顺序：${order.join(",")}`);

    // 收尾：逐个接力释放，让剩下的 cron 等待者依次拿到并归还（afterEach 会断言无残留）
    let prev: SlotRelease = manualRel;
    for (const p of cronPromises) {
      prev();
      prev = await p;
    }
    prev();
  });

  test("人工请求之间仍保持先到先得（插队不打乱人工内部顺序）", async () => {
    peakAlways();
    const occupant = await acquireExchangeSlot(200).then(track);

    const order: string[] = [];
    const firstP = acquireExchangeSlot(3000, true).then((rel) => {
      order.push("manual1");
      return track(rel);
    });
    await new Promise((r) => setTimeout(r, 20));
    const secondP = acquireExchangeSlot(3000, true).then((rel) => {
      order.push("manual2");
      return track(rel);
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(puppeteerSemaphoreStats().queuedInteractive, 2, "两个人工请求都在排队");

    occupant();
    const firstRel = await firstP;
    assert.equal(order[0], "manual1", `先到的人工请求应先被唤醒，实际：${order.join(",")}`);
    firstRel();
    (await secondP)();
  });

  test("不传 interactive 时行为不变（默认仍是 FIFO 排队尾）", async () => {
    peakAlways();
    const occupant = await acquireExchangeSlot(200).then(track);

    const order: string[] = [];
    const firstP = acquireExchangeSlot(3000).then((rel) => {
      order.push("first");
      return track(rel);
    });
    await new Promise((r) => setTimeout(r, 20));
    const secondP = acquireExchangeSlot(3000).then((rel) => {
      order.push("second");
      return track(rel);
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(puppeteerSemaphoreStats().queuedInteractive, 0, "没有人工请求");

    occupant();
    const firstRel = await firstP;
    assert.equal(order[0], "first", `默认应先到先得，实际：${order.join(",")}`);
    firstRel();
    (await secondP)();
  });

  test("人工请求超时后不留计数（queuedInteractive 归零）", async () => {
    peakAlways();
    const occupant = await acquireExchangeSlot(200).then(track);

    const r = await acquireExchangeSlot(60, true).catch((e: Error) => e);
    assert.ok(!(typeof r === "function"), "槽位被占满时人工请求也应超时，不是无限等待");
    assert.match((r as Error).message, /slot timeout/i, "应是槽位超时错误");
    assert.match((r as Error).message, /interactive/, "错误信息应标出这是人工请求，便于排障");
    assert.equal(puppeteerSemaphoreStats().queuedInteractive, 0, "超时后人工排队计数必须归零");
    occupant();
  });
});

