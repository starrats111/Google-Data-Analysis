/** D-260：强刷 07 指出的 5 个广告主快照（直连免费），输出新判定 */
process.loadEnvFile(".env");

async function main() {
  const { getOrFetchAdvertiserDomainSnapshot } = await import("../src/lib/atc-service");
  const ars = [
    "AR02174320716789317633", // 泰顺县文兰日用品店
    "AR07036586311360184321", // Qingqing Zhang
    "AR09805302258210963457", // 王福来
    "AR01414921209811828737", // 杨月莉
    "AR08578560642426863617", // 薛春
  ];
  for (const ar of ars) {
    try {
      const snap = await getOrFetchAdvertiserDomainSnapshot({
        advertiserId: ar,
        region: "US",
        serpApiKeys: [],
        forceRefresh: true,
      });
      console.log(
        `${ar} ${snap.advertiserName ?? "?"}: 在投=${snap.adCount} 唯一域名=${snap.uniqueDomainCount} 判定=${snap.classification} ocrPending=${snap.ocrPending}`
      );
    } catch (e) {
      console.error(`${ar} 失败:`, String(e).slice(0, 200));
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  process.exit(0);
}
main();
