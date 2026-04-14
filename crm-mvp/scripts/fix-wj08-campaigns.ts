/**
 * 修复 wj08 广告系列命名：
 *   1. 软删除所有非 CF 平台的广告系列（LH1、LH11 等）
 *   2. 将保留的 CF 广告系列按当前序号升序从 001 开始重新编号
 *   3. 联动刷新受影响商家状态
 *
 * 用法（在服务器 crm-mvp 目录下）：
 *   npx tsx scripts/fix-wj08-campaigns.ts
 *   npx tsx scripts/fix-wj08-campaigns.ts --dry-run   # 仅预览不执行
 */
import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";

const DRY_RUN = process.argv.includes("--dry-run");
const TARGET_USERNAME = "wj08";
const KEEP_PLATFORM_PREFIX = "CF"; // campaign_name parts[1] 以此开头视为保留

async function main() {
  loadEnvFromProjectRoot();
  const { default: prisma } = await import("../src/lib/prisma");

  // 1. 找用户
  const user = await prisma.users.findFirst({
    where: { username: TARGET_USERNAME, is_deleted: 0 },
    select: { id: true, username: true },
  });
  if (!user) {
    console.error(`❌ 用户 ${TARGET_USERNAME} 不存在`);
    process.exit(1);
  }
  console.log(`✅ 找到用户: ${user.username} (id=${user.id})`);

  // 2. 查所有正式广告系列（已提交 Google、未软删）
  const allCampaigns = await prisma.campaigns.findMany({
    where: { user_id: user.id, is_deleted: 0, google_campaign_id: { not: null } },
    select: { id: true, campaign_name: true, google_status: true, user_merchant_id: true },
    orderBy: { id: "asc" },
  });
  console.log(`\n共找到正式广告系列: ${allCampaigns.length} 条`);

  // 判断是否为 CF 系列（parts[1] 以 CF 开头，且是标准命名格式 ≥6 段）
  const isCf = (name: string | null) => {
    if (!name) return false;
    const p = name.split("-");
    return p.length >= 6 && p[1].toUpperCase().startsWith(KEEP_PLATFORM_PREFIX);
  };

  const toKeep = allCampaigns.filter((c) => isCf(c.campaign_name));
  const toDelete = allCampaigns.filter((c) => !isCf(c.campaign_name));

  console.log(`\n  将保留（CF）: ${toKeep.length} 条`);
  console.log(`  将删除（非CF）: ${toDelete.length} 条`);

  if (toDelete.length > 0) {
    console.log("\n─── 即将删除 ───");
    for (const c of toDelete) {
      console.log(`  [-] [${c.google_status}] ${c.campaign_name}`);
    }
  }

  // 3. 计算重编号方案（按当前序号升序，从 001 开始）
  const sortedKeep = [...toKeep].sort((a, b) => {
    const sa = parseInt((a.campaign_name || "").split("-")[0] || "0", 10);
    const sb = parseInt((b.campaign_name || "").split("-")[0] || "0", 10);
    return sa - sb;
  });

  const renameMap = sortedKeep.map((c, idx) => {
    const parts = (c.campaign_name || "").split("-");
    const rest = parts.slice(1).join("-");
    const newSeq = String(idx + 1).padStart(3, "0");
    return { id: c.id, oldName: c.campaign_name, newName: `${newSeq}-${rest}` };
  });

  console.log("\n─── 重编号方案 ───");
  for (const r of renameMap) {
    const changed = r.oldName !== r.newName;
    console.log(`  ${changed ? "[→]" : "[=]"} ${r.oldName}`);
    if (changed) console.log(`       ↳ ${r.newName}`);
  }

  if (DRY_RUN) {
    console.log("\n⚠️  dry-run 模式，不执行任何写操作。去掉 --dry-run 参数后重新运行以实际执行。");
    await prisma.$disconnect();
    return;
  }

  // 4. 软删除非 CF 广告系列
  const deleteIds = toDelete.map((c) => c.id);
  if (deleteIds.length > 0) {
    const deleted = await prisma.campaigns.updateMany({
      where: { id: { in: deleteIds } },
      data: { is_deleted: 1 },
    });
    console.log(`\n✅ 已软删除非CF广告系列: ${deleted.count} 条`);
  }

  // 5. 逐条重命名 CF 广告系列
  let renamedCount = 0;
  for (const r of renameMap) {
    if (r.oldName === r.newName) continue;
    await prisma.campaigns.update({
      where: { id: r.id },
      data: { campaign_name: r.newName },
    });
    console.log(`  重命名: ${r.oldName} → ${r.newName}`);
    renamedCount++;
  }
  console.log(`✅ 已重命名CF广告系列: ${renamedCount} 条`);

  // 6. 联动刷新商家状态
  const { syncMerchantStatusForUser } = await import("../src/lib/campaign-merchant-link");
  await syncMerchantStatusForUser(user.id);
  console.log("✅ 商家状态联动刷新完成");

  await prisma.$disconnect();
  console.log("\n🎉 全部完成");
}

main().catch((e) => {
  console.error("❌ 执行失败:", e);
  process.exit(1);
});
