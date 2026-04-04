// Backfill missing data for all MCCs - last 3 days via Google Ads API
const { JWT } = require('google-auth-library');

async function main() {
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({
    host: 'localhost', port: 3306,
    user: 'crm', password: 'CrmPass2026!',
    database: 'google-data-analysis'
  });

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const fmt = (d) => d.toISOString().slice(0, 10);
  const today = fmt(now);
  const d1 = new Date(now); d1.setDate(d1.getDate() - 1);
  const yesterday = fmt(d1);
  const d2 = new Date(now); d2.setDate(d2.getDate() - 2);
  const twoDaysAgo = fmt(d2);
  
  console.log('Backfill range:', twoDaysAgo, '~', today);

  const [mccs] = await conn.query(
    'SELECT id, user_id, mcc_id, mcc_name, service_account_json, developer_token, currency FROM google_mcc_accounts WHERE is_deleted=0 AND service_account_json IS NOT NULL'
  );
  console.log('Found', mccs.length, 'MCCs with service account');

  for (const mcc of mccs) {
    const [cids] = await conn.query(
      'SELECT customer_id FROM mcc_cid_accounts WHERE mcc_account_id=? AND is_deleted=0 AND status=?',
      [mcc.id, 'active']
    );
    if (cids.length === 0) {
      console.log('  MCC', mcc.mcc_name || mcc.mcc_id, '- no active CIDs, skip');
      continue;
    }

    console.log('  MCC', mcc.mcc_name || mcc.mcc_id, '(' + mcc.currency + '),', cids.length, 'CIDs');

    // Get exchange rate
    let rate = 1;
    if (mcc.currency && mcc.currency !== 'USD') {
      const [rateRows] = await conn.query(
        'SELECT rate_to_usd FROM exchange_rate_snapshots WHERE currency=? ORDER BY date DESC LIMIT 1',
        [mcc.currency.toUpperCase()]
      );
      if (rateRows.length > 0) rate = Number(rateRows[0].rate_to_usd);
      console.log('    Exchange rate', mcc.currency, '-> USD:', rate);
    }

    // Load campaigns
    const [campaigns] = await conn.query(
      'SELECT id, google_campaign_id, customer_id FROM campaigns WHERE user_id=? AND mcc_id=? AND is_deleted=0 AND google_campaign_id IS NOT NULL',
      [mcc.user_id, mcc.id]
    );
    const campaignByGcid = new Map();
    for (const c of campaigns) {
      const existing = campaignByGcid.get(c.google_campaign_id);
      if (!existing || (!existing.customer_id && c.customer_id)) {
        campaignByGcid.set(c.google_campaign_id, c);
      }
    }

    // Get JWT token
    let token;
    try {
      const sa = JSON.parse(mcc.service_account_json);
      const jwt = new JWT({
        email: sa.client_email, key: sa.private_key,
        scopes: ['https://www.googleapis.com/auth/adwords'],
        subject: sa.subject || undefined
      });
      const result = await jwt.getAccessToken();
      token = result.token;
    } catch (e) {
      console.log('    Auth failed:', e.message.slice(0, 80));
      continue;
    }

    let totalUpserted = 0;
    const devToken = (mcc.developer_token || '').trim();

    for (const cidRow of cids) {
      const cid = cidRow.customer_id.replace(/-/g, '');
      const url = 'https://googleads.googleapis.com/v23/customers/' + cid + '/googleAds:searchStream';
      const q = "SELECT campaign.id, campaign.name, campaign_budget.amount_micros, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.average_cpc, metrics.conversions, segments.date FROM campaign WHERE segments.date BETWEEN '" + twoDaysAgo + "' AND '" + today + "' AND metrics.cost_micros > 0";

      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'developer-token': devToken,
            'login-customer-id': mcc.mcc_id.replace(/-/g, ''),
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ query: q })
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          if (resp.status === 403 || errText.includes('CUSTOMER_NOT_ENABLED')) continue;
          console.log('    CID', cid, 'HTTP', resp.status);
          continue;
        }

        const data = await resp.json();
        if (!Array.isArray(data)) continue;

        for (const batch of data) {
          if (!Array.isArray(batch.results)) continue;
          for (const r of batch.results) {
            const gcid = String((r.campaign && r.campaign.id) || '');
            const dateStr = (r.segments && r.segments.date) || '';
            if (!gcid || !dateStr) continue;

            const campaign = campaignByGcid.get(gcid);
            if (!campaign) continue;

            const costMicros = Number((r.metrics && r.metrics.costMicros) || 0);
            const cost = Number((costMicros / 1e6 * rate).toFixed(2));
            const clicks = Number((r.metrics && r.metrics.clicks) || 0);
            const impressions = Number((r.metrics && r.metrics.impressions) || 0);
            const cpcMicros = Number((r.metrics && r.metrics.averageCpc) || 0);
            const cpc = Number((cpcMicros / 1e6 * rate).toFixed(4));

            // Upsert
            const [existing] = await conn.query(
              'SELECT id, cost FROM ads_daily_stats WHERE campaign_id=? AND date=? LIMIT 1',
              [campaign.id, dateStr]
            );

            if (existing.length > 0) {
              // Only update if API cost is higher (more accurate/complete)
              if (cost > Number(existing[0].cost)) {
                await conn.query(
                  'UPDATE ads_daily_stats SET cost=?, clicks=?, impressions=?, cpc=?, data_source=? WHERE id=?',
                  [cost, clicks, impressions, cpc, 'api', existing[0].id]
                );
                totalUpserted++;
              }
            } else {
              await conn.query(
                'INSERT INTO ads_daily_stats (user_id, user_merchant_id, campaign_id, date, cost, clicks, impressions, cpc, data_source, is_deleted, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,0,NOW(),NOW())',
                [mcc.user_id, 0, campaign.id, dateStr, cost, clicks, impressions, cpc, 'api']
              );
              totalUpserted++;
            }
          }
        }
      } catch (e) {
        if (!e.message.includes('PERMISSION_DENIED')) {
          console.log('    CID', cid, 'err:', e.message.slice(0, 60));
        }
      }
    }
    console.log('    Upserted:', totalUpserted, 'rows');
  }

  // Verify
  console.log('\n=== Verification ===');
  const [verify] = await conn.query(
    'SELECT DATE_FORMAT(date,"%Y-%m-%d") d, COUNT(*) cnt, ROUND(SUM(cost),2) total_cost, SUM(clicks) total_clicks FROM ads_daily_stats WHERE date >= ? AND is_deleted=0 GROUP BY date ORDER BY date',
    [twoDaysAgo]
  );
  for (const r of verify) {
    console.log(' ', r.d, 'rows=' + r.cnt, 'cost=$' + r.total_cost, 'clicks=' + r.total_clicks);
  }

  await conn.end();
  console.log('Done!');
}
main().catch(e => console.error('FATAL:', e.message));
