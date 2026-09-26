import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildOldScriptAlert } from "../src/lib/system-broadcast";

describe("buildOldScriptAlert（D-361 旧脚本催换文案）", () => {
  test("两个缺陷都没有 → null，不发通知", () => {
    assert.equal(buildOldScriptAlert("wjmcc1225（494-081-4776）", { missingBudgetCol: false, missingStatusCol: false }), null);
  });

  test("只缺 Budget 列 → 沿用原来的轻量标题，只讲预算失真", () => {
    const m = buildOldScriptAlert("A（1）", { missingBudgetCol: true, missingStatusCol: false });
    assert.ok(m);
    assert.match(m!.title, /还在旧版统一脚本/);
    assert.match(m!.content, /Budget 列/);
    assert.match(m!.content, /预算列会失真/);
    assert.doesNotMatch(m!.content, /Status 列/); // 没检出的缺陷不写进文案
  });

  test("缺 Status 列 → 标题直接点出后果，正文写明单向门", () => {
    const m = buildOldScriptAlert("wcmcc（565-124-8003）", { missingBudgetCol: false, missingStatusCol: true });
    assert.ok(m);
    assert.match(m!.title, /账户被停 CRM 不会知道/);
    assert.match(m!.content, /Status 列/);
    assert.match(m!.content, /再也不会自动恢复/);
    assert.doesNotMatch(m!.content, /Budget 列/);
  });

  test("两个都缺 → 都写，Status 列排在前面（后果更重）", () => {
    const m = buildOldScriptAlert("A（1）", { missingBudgetCol: true, missingStatusCol: true });
    assert.ok(m);
    assert.match(m!.title, /账户被停 CRM 不会知道/);
    const iStatus = m!.content.indexOf("Status 列");
    const iBudget = m!.content.indexOf("Budget 列");
    assert.ok(iStatus > -1 && iBudget > -1);
    assert.ok(iStatus < iBudget, "Status 列的后果应排在 Budget 之前");
  });

  test("任何一种都带上修法（去哪点什么）", () => {
    for (const d of [
      { missingBudgetCol: true, missingStatusCol: false },
      { missingBudgetCol: false, missingStatusCol: true },
      { missingBudgetCol: true, missingStatusCol: true },
    ]) {
      const m = buildOldScriptAlert("A（1）", d);
      assert.match(m!.content, /设置 → MCC 账户/);
      assert.match(m!.content, /复制脚本/);
    }
  });
});
