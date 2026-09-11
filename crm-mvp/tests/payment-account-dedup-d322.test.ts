/**
 * D-322：打款单必须按「物理联盟账户」去重，不能按 api_key / account_name。
 *
 * 起因：jyzu 组月报里 蓝倩倩 的 PM1 / PM2 两列显示完全相同的应收/实收（5,769.28 + 858.75），
 * 合计虚增 $6,628.03。根因是联盟「支付/打款」接口按**账户**返回：一把 key 拉回整个 publisher
 * 账户的全部打款单，与该 key 挂在哪个 channel/子站无关。affiliate_payments 唯一键含
 * platform_connection_id，同一 payment_no 落到同账户的两条连接就是两行，DB 层拦不住。
 *
 * 既有两道防线同时失守：
 *   1) sync 按 (platform, api_key) 去重 —— 同一账户签发多把 key 时不命中（PM conn#219/#320）；
 *   2) resolveMainConnectionMap 按 account_name 归一 —— 2026-08-24 那批把占位名(PM1/PM2)
 *      改成真实账号名(yubin weng/carey/…)，按名分组即失守，次日同步全量重写一份。
 * 全库共 83 行重复、$173,982.05，覆盖 2025-08 起每个月。
 *
 * 本测试钉住三条：
 *   - 同一 payment_account_key 的连接必须归到同一主连接（哪怕 api_key 和账号名都不同）；
 *   - 跨成员误挂同一物理账户时也必须收敛（LH conn#243 属 u29 / #323 属 u19）；
 *   - 未标注 payment_account_key 时回退旧口径（user+平台+账号名），不改变存量行为。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

describe("D-322 打款按物理账户去重", () => {
  it("resolveMainConnectionMap 用 payment_account_key 分组，不用 account_name", () => {
    const src = readFileSync(join(SRC, "lib", "payment-main-connection.ts"), "utf8");
    assert.match(
      src,
      /payment_account_key/,
      "resolveMainConnectionMap 必须读 payment_account_key —— 只按 account_name 分组会在改名后失守",
    );
    // 已标注物理账户时分组键不能含 user_id：跨成员误挂也必须收敛到同一主连接
    assert.match(
      src,
      /acct\|\$\{platform\}\|\$\{acctKey\}/,
      "已标注物理账户的分组键必须是 平台+账户（不含 user_id），否则跨成员误挂时两人各记一份",
    );
    // 未标注时保留旧口径
    assert.match(
      src,
      /\$\{c\.user_id\}\|\$\{platform\}\|\$\{norm\(c\.account_name\)\}/,
      "未标注 payment_account_key 的连接必须回退 user+平台+账号名，保持存量行为",
    );
  });

  it("两处同步入口都按 payment_account_key 去重账户，而非仅 api_key", () => {
    for (const rel of [
      ["app", "api", "user", "data-center", "sync-payments", "route.ts"],
      ["app", "api", "cron", "daily-sync", "route.ts"],
    ]) {
      const p = join(SRC, ...rel);
      const src = readFileSync(p, "utf8");
      assert.match(
        src,
        /acct::\$\{acctKey\}/,
        `${rel.join("/")} 的账户去重键必须优先用 payment_account_key`,
      );
    }
  });

  it("daily-sync 一次性全量取连接后再归一（per-user 取会看不见跨成员同账户）", () => {
    const src = readFileSync(join(SRC, "app", "api", "cron", "daily-sync", "route.ts"), "utf8");
    // 只看打款同步这个函数体，文件里别处也有 for (const user of users)
    const fnAt = src.indexOf("async function syncAllUsersPayments");
    assert.notEqual(fnAt, -1, "找不到 syncAllUsersPayments");
    const body = src.slice(fnAt);
    const allConnsAt = body.indexOf("const allConns = await prisma.platform_connections.findMany");
    assert.notEqual(allConnsAt, -1, "daily-sync 打款同步必须先全量取连接（allConns）");
    const resolveAt = body.indexOf("resolveMainConnectionMap(allConns)");
    assert.notEqual(resolveAt, -1, "必须对全量连接做归一，否则跨成员同账户永远归不到一起");
    const loopAt = body.indexOf("for (const user of users)");
    assert.notEqual(loopAt, -1, "找不到 per-user 循环");
    assert.ok(
      allConnsAt < loopAt && resolveAt < loopAt,
      "全量取连接与归一都必须发生在 per-user 循环之前",
    );
  });

  it("打款行整行归主连接：user_id 也取主连接归属人", () => {
    for (const rel of [
      ["app", "api", "user", "data-center", "sync-payments", "route.ts"],
      ["app", "api", "cron", "daily-sync", "route.ts"],
    ]) {
      const src = readFileSync(join(SRC, ...rel), "utf8");
      assert.match(
        src,
        /ownerByConnId/,
        `${rel.join("/")} 必须按主连接解析归属人，避免写出 user_id 与 conn 不一致的错行`,
      );
      assert.match(
        src,
        /user_id:\s*ownerId/,
        `${rel.join("/")} 的 create 必须用 ownerId 作为 user_id`,
      );
    }
  });

  it("删连接时打款行不按 user_id 过滤地级联软删（否则留下会被兜底吸走的孤儿）", () => {
    const src = readFileSync(join(SRC, "app", "api", "user", "settings", "platforms", "route.ts"), "utf8");
    // 取 affiliate_payments.updateMany 那段，断言 where 里没有 user_id
    const i = src.indexOf("prisma.affiliate_payments.updateMany");
    assert.notEqual(i, -1, "删连接必须级联软删该连接的打款记录");
    const seg = src.slice(i, i + 260);
    assert.ok(
      !/user_id/.test(seg),
      "级联软删打款行不能按 user_id 过滤：跨成员误挂时打款行的归属人可能是另一个人，加了就漏删",
    );
    assert.match(seg, /platform_connection_id:\s*connId/, "必须按连接 id 级联");
  });

  it("月报打款兜底要求同一物理账户（孤儿行不得并入他人列）", () => {
    const src = readFileSync(join(SRC, "lib", "monthly-report.ts"), "utf8");
    assert.match(
      src,
      /requireAccountKey/,
      "resolveColKey 必须支持 requireAccountKey，收紧打款口径的「平台唯一列」兜底",
    );
    assert.match(
      src,
      /acctKeysByColKey/,
      "必须维护每列覆盖的物理账户集合，供兜底校验",
    );
    // 未标注物理账户时必须拒绝兜底，宁可报警也不并入
    assert.match(
      src,
      /if \(!requireAccountKey\) return null;/,
      "未标注物理账户的孤儿打款行必须拒绝兜底（报警而非静默并入他人列）",
    );
  });
});
