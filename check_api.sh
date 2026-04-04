#!/bin/bash
# Directly call the campaigns API as wj07
# First get wj07's user id
USER_ID=$(mysql -u crm -pCrmPass2026! google-data-analysis -N -e "SELECT id FROM users WHERE username = 'wj07'")
echo "wj07 user_id: $USER_ID"

# Simulate API call using node
cd /home/ubuntu/Google-Data-Analysis/crm-mvp

node -e "
const { PrismaClient } = require('./src/generated/prisma');
const prisma = new PrismaClient();

async function main() {
  const userId = BigInt($USER_ID);
  const start = new Date('2026-03-01T00:00:00+08:00');
  const end = new Date('2026-03-27T23:59:59+08:00');

  // Get all campaigns
  const allMcc = await prisma.google_mcc_accounts.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true, mcc_id: true, mcc_name: true, currency: true },
  });
  console.log('MCCs:', allMcc.map(m => ({ id: Number(m.id), name: m.mcc_name, currency: m.currency })));

  const mccIds = allMcc.map(m => m.id);
  const campaigns = await prisma.campaigns.findMany({
    where: { user_id: userId, google_campaign_id: { not: null }, is_deleted: 0, mcc_id: { in: mccIds } },
    select: { id: true, google_campaign_id: true, customer_id: true, campaign_name: true, mcc_id: true },
    orderBy: { id: 'desc' },
  });
  console.log('Campaign count:', campaigns.length);

  // Dedup
  const gcidGroups = new Map();
  for (const c of campaigns) {
    const gcid = c.google_campaign_id || String(c.id);
    if (!gcidGroups.has(gcid)) gcidGroups.set(gcid, []);
    gcidGroups.get(gcid).push(c);
  }
  const dedupedCampaigns = [];
  const extraIds = [];
  for (const [, group] of gcidGroups) {
    group.sort((a, b) => {
      if (a.customer_id && !b.customer_id) return -1;
      if (!a.customer_id && b.customer_id) return 1;
      return Number(b.id) - Number(a.id);
    });
    dedupedCampaigns.push(group[0]);
    for (let i = 1; i < group.length; i++) extraIds.push(group[i].id);
  }
  console.log('Deduped campaigns:', dedupedCampaigns.length, 'Extra:', extraIds.length);

  // Stats
  const allIds = [...dedupedCampaigns.map(c => c.id), ...extraIds];
  const rawStats = await prisma.ads_daily_stats.groupBy({
    by: ['campaign_id'],
    where: { campaign_id: { in: allIds }, date: { gte: start, lt: end }, is_deleted: 0 },
    _sum: { cost: true, clicks: true, impressions: true },
  });
  console.log('Stats rows:', rawStats.length);

  // Build mapping
  const campaignIdToGcid = new Map();
  for (const c of campaigns) {
    campaignIdToGcid.set(String(c.id), c.google_campaign_id || String(c.id));
  }
  const gcidToPrimary = new Map();
  for (const c of dedupedCampaigns) {
    gcidToPrimary.set(c.google_campaign_id || String(c.id), String(c.id));
  }

  const statsMap = new Map();
  for (const s of rawStats) {
    const gcid = campaignIdToGcid.get(String(s.campaign_id));
    const primaryId = gcid ? gcidToPrimary.get(gcid) : String(s.campaign_id);
    const key = primaryId || String(s.campaign_id);
    const existing = statsMap.get(key);
    const cost = Number(s._sum?.cost || 0);
    if (!existing || cost > existing.cost) {
      statsMap.set(key, { cost, clicks: Number(s._sum?.clicks||0), impressions: Number(s._sum?.impressions||0) });
    }
  }

  let totalCost = 0;
  for (const c of dedupedCampaigns) {
    const s = statsMap.get(String(c.id));
    const cost = s?.cost || 0;
    totalCost += cost;
    if (cost > 0) {
      console.log('  ', c.campaign_name, '-> cost:', cost.toFixed(2));
    }
  }
  console.log('Total cost from API logic:', totalCost.toFixed(2));

  // Check adjustments
  const adjustments = await prisma.mcc_cost_adjustments.findMany({
    where: { user_id: userId, month: '2026-03', is_deleted: 0 },
  });
  let totalAdj = 0;
  for (const a of adjustments) {
    const amt = Number(a.amount);
    console.log('Adjustment:', amt, 'for mcc_account_id:', Number(a.mcc_account_id));
    totalAdj += amt;
  }
  console.log('Total with adjustments:', (totalCost + totalAdj).toFixed(2));

  await prisma.\$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
" 2>&1
