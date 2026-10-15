import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPlatformCondition } from "../src/lib/campaign-board-query";

/** 把 where 片段在内存里跑一遍，模拟 Prisma 的 contains / in / null 语义 */
function matches(
  cond: Record<string, unknown>,
  row: { campaign_name: string; platform_connection_id: bigint | null },
): boolean {
  if (Array.isArray(cond.OR)) {
    return (cond.OR as Record<string, unknown>[]).some((c) => matches(c, row));
  }
  let ok = true;
  if ("platform_connection_id" in cond) {
    const want = cond.platform_connection_id;
    if (want === null) {
      ok = ok && row.platform_connection_id === null;
    } else {
      const ids = (want as { in: bigint[] }).in;
      ok = ok && row.platform_connection_id !== null &&
        ids.some((i) => i === row.platform_connection_id);
    }
  }
  if ("campaign_name" in cond) {
    const sub = (cond.campaign_name as { contains: string }).contains;
    ok = ok && row.campaign_name.includes(sub);
  }
  return ok;
}

describe("D-367 平台筛选：系列名的平台段带账号位次，裸 `-PM-` 匹配不到", () => {
  it("wj04 报案的真实系列名：带位次的 PM1 / PM8 / PM3 必须命中", () => {
    const cond = buildPlatformCondition("PM", [BigInt(13), BigInt(217)]);
    for (const name of [
      "544-PM1-Club Med-GB-0724-83599",
      "760-PM8-Hamilton-FR-1013-73399",
      "589-PM3-Electronics Expo-US-0814-18645439",
    ]) {
      assert.equal(
        matches(cond, { campaign_name: name, platform_connection_id: BigInt(13) }),
        true,
        name,
      );
    }
  });

  it("老式裸命名（2026-03 前）仍要命中，否则修一头坏一头", () => {
    const cond = buildPlatformCondition("CG", [BigInt(5)]);
    assert.equal(
      matches(cond, {
        campaign_name: "256-CG-CamplifySpain-ES-0403-10090233",
        platform_connection_id: BigInt(5),
      }),
      true,
    );
  });

  it("判据是连接而不是名字：名字里没有平台段，连接对了也命中", () => {
    const cond = buildPlatformCondition("PM", [BigInt(13)]);
    assert.equal(
      matches(cond, { campaign_name: "Campaign #1", platform_connection_id: BigInt(13) }),
      true,
    );
  });

  it("别人平台的广告不能混进来（连接不在列表、名字也不带 PM 段）", () => {
    const cond = buildPlatformCondition("PM", [BigInt(13)]);
    assert.equal(
      matches(cond, {
        campaign_name: "667-CG1-Bur Bur-US-0912-18648277",
        platform_connection_id: BigInt(9),
      }),
      false,
    );
  });

  it("无连接的行退回名字兜底：裸段与带位次两种写法都认", () => {
    const cond = buildPlatformCondition("PM", [BigInt(13)]);
    for (const name of ["544-PM1-Club Med-GB-0724-83599", "300-PM-Foo-US-0101-1"]) {
      assert.equal(
        matches(cond, { campaign_name: name, platform_connection_id: null }),
        true,
        name,
      );
    }
  });

  it("兜底不能放松成 `-PM` 前缀匹配：商家名里带 -PM 的不算", () => {
    const cond = buildPlatformCondition("PM", [BigInt(13)]);
    // 平台段是 CG，商家名里碰巧出现 -PMx；松口径会误命中
    assert.equal(
      matches(cond, {
        campaign_name: "667-CG1-Acme-PMx Edition-US-0912-18648277",
        platform_connection_id: null,
      }),
      false,
    );
  });

  it("该用户在该平台还没建连接时，只靠名字兜底，不能退化成全表命中", () => {
    const cond = buildPlatformCondition("PM", []);
    assert.equal(
      matches(cond, { campaign_name: "544-PM1-Club Med-GB-0724-83599", platform_connection_id: null }),
      true,
    );
    assert.equal(
      matches(cond, { campaign_name: "667-CG1-Bur Bur-US-0912-18648277", platform_connection_id: null }),
      false,
    );
  });

  it("PB / PM 这类互为前缀隐患的代码不串台", () => {
    const pb = buildPlatformCondition("PB", []);
    assert.equal(
      matches(pb, { campaign_name: "544-PM1-Club Med-GB-0724-83599", platform_connection_id: null }),
      false,
    );
    assert.equal(
      matches(pb, { campaign_name: "610-PB1-Piscifun-US-0827-138980", platform_connection_id: null }),
      true,
    );
  });
});
