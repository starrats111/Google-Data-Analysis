import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickCampaignAffiliateLink, type ConnectionAliasMap } from "../src/lib/merchant-connection";

const PM1_LINK = "https://app.partnermatic.com/track/pm1?url=https%3A%2F%2Fgarrettwade.com";
const PM2_LINK = "https://app.partnermatic.com/track/pm2?url=https%3A%2F%2Fgarrettwade.com";

// wj04 的 PM1(conn13) 与 PM8(conn217) 共用同一份 api_key，是同一个 Partnermatic 账号
const sameAccount: ConnectionAliasMap = new Map([
  ["13", ["217"]],
  ["217", ["13"]],
]);

describe("pickCampaignAffiliateLink 归属账号优先", () => {
  it("归属账号自己有链接时直接用它", () => {
    const link = pickCampaignAffiliateLink(BigInt(217), {
      connection_campaign_links: { "13": PM1_LINK, "217": PM2_LINK },
      platform_connection_id: BigInt(13),
    });
    assert.equal(link, PM2_LINK);
  });

  it("归属账号就是商家主连接时用主链接", () => {
    const link = pickCampaignAffiliateLink(BigInt(13), {
      tracking_link: PM1_LINK,
      platform_connection_id: BigInt(13),
    });
    assert.equal(link, PM1_LINK);
  });

  it("归属账号无链接且无等价表时返回空，不串到别号", () => {
    const link = pickCampaignAffiliateLink(BigInt(217), {
      connection_campaign_links: { "13": PM1_LINK },
      platform_connection_id: BigInt(13),
    });
    assert.equal(link, "");
  });
});

describe("pickCampaignAffiliateLink D-192 同账号等价回退", () => {
  it("链接挂在同一账号的另一条连接下时放行（garrett wade 原始故障）", () => {
    const link = pickCampaignAffiliateLink(
      BigInt(217),
      {
        connection_campaign_links: { "13": PM1_LINK },
        platform_connection_id: BigInt(13),
      },
      sameAccount,
    );
    assert.equal(link, PM1_LINK);
  });

  it("等价连接只有主链接（无 per-conn 键）时也放行", () => {
    const link = pickCampaignAffiliateLink(
      BigInt(217),
      {
        tracking_link: PM1_LINK,
        platform_connection_id: BigInt(13),
      },
      sameAccount,
    );
    assert.equal(link, PM1_LINK);
  });

  it("等价表里没有的连接仍然拒绝，防真串号", () => {
    const link = pickCampaignAffiliateLink(
      BigInt(999),
      {
        connection_campaign_links: { "13": PM1_LINK },
        platform_connection_id: BigInt(13),
      },
      sameAccount,
    );
    assert.equal(link, "");
  });

  it("等价连接同样没有该商家链接时仍返回空", () => {
    const link = pickCampaignAffiliateLink(
      BigInt(217),
      {
        connection_campaign_links: { "42": PM2_LINK },
        platform_connection_id: BigInt(42),
      },
      sameAccount,
    );
    assert.equal(link, "");
  });
});
