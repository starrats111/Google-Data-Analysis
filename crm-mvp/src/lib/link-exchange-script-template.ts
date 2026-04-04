/**
 * 生成完整的 Google Ads 换链接脚本
 * 包含 click-baseline 跨实例状态同步（启动时读取、退出前写入）
 *
 * @param apiKey       用户的 Script API Key（ky_live_xxx）
 * @param apiBaseUrl   CRM 后端地址，默认生产域名
 * @param sheetUrl     Google Sheet 链接，由员工填写
 */
export function generateLinkExchangeScript(
  apiKey: string,
  apiBaseUrl = 'https://google-data-analysis.top',
  sheetUrl = 'https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit'
): string {
  const base = apiBaseUrl.replace(/\/$/, '')
  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })

  return `// Google Ads Script: Campaign 扫描 + 联盟链接 + 点击监控换链
// 生成时间: ${ts}

// ===== 配置区域 =====
var CONFIG = {
  // Google 表格配置
  SPREADSHEET_URL: '${sheetUrl}',
  SHEET_NAME: '工作表1',
  CLEAR_BEFORE_WRITE: true,

  // API 配置（已自动填写）
  API_BASE_URL: '${base}',
  API_KEY: '${apiKey}',

  // 循环监控配置
  LOOP_INTERVAL_SECONDS: 30,
  CYCLE_MINUTES: 30,

  // 时间限制配置（Google Ads Script 最长运行 30 分钟）
  // 28 分钟 = 1680 秒，预留 2 分钟安全缓冲
  MAX_RUNTIME_SECONDS: 28 * 60,

  // 批量大小
  BATCH_SIZE: 100,

  // 功能开关
  ENABLE_AFFILIATE_LOOKUP: true,
  ENABLE_SHEET_WRITE: true,
  ENABLE_SUFFIX_APPLY: true,
  ONLY_APPLY_WHEN_AFFILIATE_FOUND: true,
  DRY_RUN: false,

  // 调试开关
  DEBUG_CLICKS: false,
  DEBUG_CLICKS_SAMPLE_SIZE: 20,
  DEBUG_LEASE: false,

  // Campaign 名称解析配置
  VALID_NETWORKS: ['RW', 'LH', 'PM', 'LB', 'CG', 'CF', 'BSH', 'TJ', 'AW'],

  // 时间检查间隔配置
  TIME_CHECK_ACCOUNTS_INTERVAL: 5,
  TIME_CHECK_CID_INTERVAL: 3,
  TIME_CHECK_RESULTS_INTERVAL: 5,

  // 批量回传配置
  REPORT_BATCH_THRESHOLD: 50,

  // 基线有效期（毫秒），超过此时间的基线视为过旧，不使用
  BASELINE_MAX_AGE_MS: 2 * 60 * 60 * 1000  // 2 小时
};

// ===== 表头定义 =====
var COLUMN_HEADERS = [
  'campaignId', 'campaignName', 'country', 'finalUrl', 'todayClicks',
  'cid', 'mccId', 'networkShortName', 'mid', 'trackingUrl',
  'hasAffiliate', 'lastClicks', 'currentClicks', 'lastSuffix', 'lastApplyTime',
  'status', 'updatedAt'
];

// ===== 运行态 =====
var STATE = {
  startTime: null,
  scriptInstanceId: '',
  campaignMap: {},
  accountsByCid: {},
  timeZoneByCid: {},
  forceStopped: false,
  stats: {
    loopCount: 0,
    totalLoopTime: 0,
    clickGrowthLoops: 0,
    clickGrowthCampaigns: 0,
    skippedNoAffiliate: 0,
    suffixApplySuccess: 0,
    suffixApplyFailed: 0,
    noopCount: 0,
    noStockCount: 0,
    apiErrorCount: 0,
    unknownResponseCount: 0,
    monitoringStartTime: null,
    lowStockCampaigns: {}
  },
  affiliateStats: { found: 0, notFound: 0 }
};

// =====================================================================
// 时间控制
// =====================================================================
function shouldStop(phase) {
  if (STATE.forceStopped) return true;
  var elapsed = (new Date() - STATE.startTime) / 1000;
  if (elapsed >= CONFIG.MAX_RUNTIME_SECONDS) {
    STATE.forceStopped = true;
    console.log('');
    console.log('⛔ 强制停止: 已运行 ' + Math.floor(elapsed) + ' 秒，接近 30 分钟限制');
    console.log('   停止位置: ' + (phase || 'unknown'));
    return true;
  }
  return false;
}

function getRemainingSeconds() {
  var elapsed = (new Date() - STATE.startTime) / 1000;
  return Math.max(0, CONFIG.MAX_RUNTIME_SECONDS - elapsed);
}

// =====================================================================
// 主入口
// =====================================================================
function main() {
  STATE.startTime = new Date();
  STATE.scriptInstanceId = generateInstanceId();
  STATE.forceStopped = false;

  var timeZone = AdsApp.currentAccount().getTimeZone();
  var mccId = AdsApp.currentAccount().getCustomerId();
  console.log('开始: ' + formatDateTime(STATE.startTime, timeZone) +
    ' | MCC ' + mccId + ' | ' + STATE.scriptInstanceId +
    ' | 上限' + CONFIG.MAX_RUNTIME_SECONDS + 's');

  // ===== 阶段 1: 扫描广告系列 =====
  console.log('===== 阶段1: 扫描广告系列 =====');
  var campaigns = scanAllCampaigns(mccId);
  console.log('广告系列总数: ' + campaigns.length);

  if (shouldStop('阶段1结束')) { logFinalReport(timeZone, campaigns); return; }
  if (campaigns.length === 0) { console.log('无广告系列，退出。'); return; }

  // ===== 阶段 2: 获取联盟链接 =====
  console.log('===== 阶段2: 获取联盟链接 =====');
  if (CONFIG.ENABLE_AFFILIATE_LOOKUP && !shouldStop('阶段2开始')) {
    campaigns = fetchAffiliateLinks(campaigns);
  } else if (!CONFIG.ENABLE_AFFILIATE_LOOKUP) {
    console.log('联盟链接查询已禁用。');
  }
  if (shouldStop('阶段2结束')) { logFinalReport(timeZone, campaigns); return; }

  // ===== 阶段 3: 写入表格 =====
  console.log('===== 阶段3: 写入表格 =====');
  if (CONFIG.ENABLE_SHEET_WRITE && !shouldStop('阶段3开始')) {
    writeToSheet(campaigns);
  } else if (!CONFIG.ENABLE_SHEET_WRITE) {
    console.log('表格写入已禁用。');
  }
  if (shouldStop('阶段3结束')) { logFinalReport(timeZone, campaigns); return; }

  // ===== 阶段 4: 初始化点击数 =====
  console.log('===== 阶段4: 初始化点击数 =====');
  initClicksState(campaigns);

  // ===== 新增: 从 CRM 读取点击基线，继承上次脚本的状态 =====
  loadClickBaselines(campaigns);

  // ===== 阶段 5: 循环监控并换链 =====
  console.log('===== 阶段5: 循环监控 | 剩余' + Math.floor(getRemainingSeconds()) + '秒 =====');
  if (CONFIG.ENABLE_SUFFIX_APPLY && !shouldStop('阶段5开始')) {
    runMonitoringLoop(campaigns, mccId);
  } else if (!CONFIG.ENABLE_SUFFIX_APPLY) {
    console.log('后缀写入已禁用。');
  }

  logFinalReport(timeZone, campaigns);
}

// =====================================================================
// 最终报告（退出前写入点击基线）
// =====================================================================
function logFinalReport(timeZone, campaigns) {
  var endTime = new Date();
  var totalDuration = (endTime - STATE.startTime) / 1000;
  var stats = STATE.stats;
  var campaignCount = campaigns ? campaigns.length : 0;

  console.log('');
  console.log('===== 运行报告 | ' + formatDuration(totalDuration) +
    ' | ' + campaignCount + '系列 | ' + formatDateTime(endTime, timeZone) + ' =====');

  if (stats.monitoringStartTime) {
    var monitoringDuration = stats.totalLoopTime || 0;
    var avgLoopTime = stats.loopCount > 0 ? (monitoringDuration / stats.loopCount) : 0;
    var monitoringRatio = totalDuration > 0 ? (monitoringDuration / totalDuration * 100) : 0;
    console.log('循环' + stats.loopCount + '次(' + avgLoopTime.toFixed(1) + 's/次)' +
      ' 增长' + stats.clickGrowthLoops + '轮/' + stats.clickGrowthCampaigns + '次' +
      ' | 写入:' + stats.suffixApplySuccess + '✅ ' + stats.suffixApplyFailed + '❌' +
      ' | NOOP=' + stats.noopCount + ' NO_STOCK=' + stats.noStockCount +
      ' ERR=' + stats.apiErrorCount +
      (stats.unknownResponseCount > 0 ? ' UNK=' + stats.unknownResponseCount : ''));
    var affiliateStats = STATE.affiliateStats;
    console.log('联盟:找到' + affiliateStats.found + ' 未找到' + affiliateStats.notFound +
      ' | 无联盟跳过' + stats.skippedNoAffiliate +
      ' | 监控占比' + monitoringRatio.toFixed(1) + '%');
  }

  var lowStockCampaigns = stats.lowStockCampaigns || {};
  var lowStockIds = Object.keys(lowStockCampaigns);
  if (lowStockIds.length > 0) {
    lowStockIds.sort(function(a, b) {
      return lowStockCampaigns[a].stock - lowStockCampaigns[b].stock;
    });
    var lsParts = [];
    var displayCount = Math.min(lowStockIds.length, 8);
    for (var li = 0; li < displayCount; li++) {
      var lsInfo = lowStockCampaigns[lowStockIds[li]];
      var lsNameParts = lsInfo.name.split('-');
      var lsShort = lsNameParts.length >= 3 ? lsNameParts[2] : lsInfo.name.substring(0, 12);
      lsParts.push(lsShort + '(S' + lsInfo.stock + ',×' + lsInfo.count + ')');
    }
    var lsExtra = lowStockIds.length > 8 ? ' +' + (lowStockIds.length - 8) + '个' : '';
    console.log('⚠️ 低库存(' + lowStockIds.length + '): ' + lsParts.join(' ') + lsExtra + ' | 请补货');
  }

  // 退出前将当前点击数写入 CRM，供下次启动时读取
  saveClickBaselines(campaigns);

  console.log(STATE.forceStopped ? '状态: ⛔ 因时间限制停止' : '状态: ✅ 正常结束');
}

// =====================================================================
// 点击基线：从 CRM 读取（启动时调用）
// =====================================================================
function loadClickBaselines(campaigns) {
  if (!CONFIG.API_BASE_URL || !CONFIG.API_KEY) return;
  if (!campaigns || campaigns.length === 0) return;

  var ids = [];
  for (var i = 0; i < campaigns.length; i++) {
    if (campaigns[i].campaignId) ids.push(campaigns[i].campaignId);
  }
  if (ids.length === 0) return;

  // 每批最多 500 个 ID
  var batchSize = 500;
  var baselineMap = {};
  for (var b = 0; b < ids.length; b += batchSize) {
    var batch = ids.slice(b, b + batchSize);
    try {
      var url = CONFIG.API_BASE_URL.replace(/\\/$/, '') +
        '/api/v1/click-baseline?campaignIds=' + batch.join(',');
      var resp = UrlFetchApp.fetch(url, {
        headers: {
          'Authorization': 'Bearer ' + CONFIG.API_KEY,
          'X-Api-Key': CONFIG.API_KEY
        },
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() === 200) {
        var data = JSON.parse(resp.getContentText());
        if (data.success && data.baselines) {
          for (var cid in data.baselines) {
            baselineMap[cid] = data.baselines[cid];
          }
        }
      }
    } catch (e) {
      console.log('加载点击基线失败: ' + e.message);
    }
  }

  var now = new Date();
  var applied = 0;
  for (var j = 0; j < campaigns.length; j++) {
    var c = campaigns[j];
    var baseline = baselineMap[c.campaignId];
    if (!baseline || typeof baseline.clicks !== 'number') continue;

    // 基线新鲜度检查
    if (baseline.checkpointAt) {
      var age = now.getTime() - new Date(baseline.checkpointAt).getTime();
      if (age > CONFIG.BASELINE_MAX_AGE_MS) continue;  // 基线过旧，跳过
    }

    // 基线必须 ≤ 当前点击数（防止日期重置误判）
    if (baseline.clicks >= 0 && baseline.clicks <= c.currentClicks) {
      c.lastClicks = baseline.clicks;
      applied++;
    }
  }

  if (applied > 0) {
    console.log('基线加载: ' + applied + '/' + campaigns.length +
      ' 个广告系列已从 CRM 恢复点击基线');
  }
}

// =====================================================================
// 点击基线：写入 CRM（退出前调用）
// =====================================================================
function saveClickBaselines(campaigns) {
  if (!CONFIG.API_BASE_URL || !CONFIG.API_KEY) return;
  if (!campaigns || campaigns.length === 0) return;

  var items = [];
  for (var i = 0; i < campaigns.length; i++) {
    var c = campaigns[i];
    if (c.campaignId && typeof c.currentClicks === 'number') {
      items.push({ campaignId: c.campaignId, clicks: c.currentClicks });
    }
  }
  if (items.length === 0) return;

  try {
    var url = CONFIG.API_BASE_URL.replace(/\\/$/, '') + '/api/v1/click-baseline';
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'Authorization': 'Bearer ' + CONFIG.API_KEY,
        'X-Api-Key': CONFIG.API_KEY
      },
      payload: JSON.stringify({ campaigns: items }),
      muteHttpExceptions: true
    });
    console.log('基线已保存: ' + items.length + ' 个广告系列');
  } catch (e) {
    console.log('保存点击基线失败: ' + e.message);
  }
}

// =====================================================================
// 扫描 Campaign
// =====================================================================
function scanAllCampaigns(mccId) {
  var allCampaigns = [];
  var accounts = [];
  var accountIterator = AdsManagerApp.accounts().get();
  while (accountIterator.hasNext()) {
    var account = accountIterator.next();
    accounts.push(account);
    STATE.accountsByCid[account.getCustomerId()] = account;
  }
  console.log('发现账户数: ' + accounts.length);

  var errorCount = 0;
  for (var i = 0; i < accounts.length; i++) {
    if (i > 0 && i % CONFIG.TIME_CHECK_ACCOUNTS_INTERVAL === 0 && shouldStop('扫描账户 #' + i)) {
      console.log('   扫描中断，已处理 ' + i + '/' + accounts.length + ' 个账户');
      break;
    }
    var account = accounts[i];
    try { AdsManagerApp.select(account); } catch (e) { errorCount++; continue; }

    var cid = AdsApp.currentAccount().getCustomerId();
    STATE.timeZoneByCid[cid] = AdsApp.currentAccount().getTimeZone();

    try {
      var campaigns = getCampaignData(cid, mccId);
      if (campaigns.length > 0) {
        allCampaigns = allCampaigns.concat(campaigns);
      }
    } catch (e) {
      console.log('   错误: ' + AdsApp.currentAccount().getName() + ' (' + cid + ') -> ' + e.message);
      errorCount++;
    }
  }
  if (errorCount > 0) console.log('   扫描错误: ' + errorCount + ' 个账户');
  return allCampaigns;
}

function getCampaignData(cid, mccId) {
  var campaigns = [];
  var now = new Date().toISOString();
  var campaignMap = {};

  var campaignRows = AdsApp.report(
    'SELECT campaign.id, campaign.name FROM campaign WHERE campaign.status = \\'ENABLED\\''
  ).rows();
  while (campaignRows.hasNext()) {
    var row = campaignRows.next();
    var campaignId = row['campaign.id'];
    var campaignName = row['campaign.name'];
    var parsed = parseCampaignName(campaignName);
    campaignMap[campaignId] = {
      campaignId: campaignId, campaignName: campaignName, country: '',
      finalUrl: '', todayClicks: 0, cid: cid, mccId: mccId,
      networkShortName: parsed.networkShortName, mid: parsed.mid,
      trackingUrl: '', hasAffiliate: false,
      lastClicks: 0, currentClicks: 0, lastSuffix: '', lastApplyTime: '',
      status: parsed.parsed ? 'ready' : 'no_affiliate_info', updatedAt: now
    };
  }

  if (Object.keys(campaignMap).length === 0) return campaigns;

  try {
    var clicksRows = AdsApp.report(
      'SELECT campaign.id, metrics.clicks FROM campaign ' +
      'WHERE campaign.status = \\'ENABLED\\' AND segments.date DURING TODAY'
    ).rows();
    while (clicksRows.hasNext()) {
      var cRow = clicksRows.next();
      if (campaignMap[cRow['campaign.id']]) {
        campaignMap[cRow['campaign.id']].todayClicks = parseInt(cRow['metrics.clicks'], 10) || 0;
      }
    }
  } catch (e) { console.log('   警告: 获取点击数失败 ' + cid + ' -> ' + e.message); }

  try {
    var geoRows = AdsApp.report(
      'SELECT campaign.id, campaign_criterion.location.geo_target_constant ' +
      'FROM campaign_criterion ' +
      'WHERE campaign.status = \\'ENABLED\\' AND campaign_criterion.type = LOCATION ' +
      'AND campaign_criterion.negative = false'
    ).rows();
    var geoMap = {};
    while (geoRows.hasNext()) {
      var gRow = geoRows.next();
      var gId = gRow['campaign.id'];
      var gc = gRow['campaign_criterion.location.geo_target_constant'];
      if (!geoMap[gId]) geoMap[gId] = [];
      if (gc && geoMap[gId].indexOf(gc) === -1) geoMap[gId].push(gc);
    }
    for (var id in geoMap) {
      if (campaignMap[id]) campaignMap[id].country = geoMap[id].join(', ');
    }
  } catch (e) { console.log('   警告: 获取地理定向失败 ' + cid + ' -> ' + e.message); }

  try {
    var adRows = AdsApp.report('SELECT campaign.id, ad_group_ad.ad.final_urls FROM ad_group_ad').rows();
    var urlMap = {};
    while (adRows.hasNext()) {
      var aRow = adRows.next();
      var aId = aRow['campaign.id'];
      var finalUrls = aRow['ad_group_ad.ad.final_urls'];
      if (!urlMap[aId] && finalUrls && finalUrls.length > 0) urlMap[aId] = finalUrls[0];
    }
    for (var uId in urlMap) {
      if (campaignMap[uId]) campaignMap[uId].finalUrl = urlMap[uId];
    }
  } catch (e) { console.log('   警告: 获取最终网址失败 ' + cid + ' -> ' + e.message); }

  for (var key in campaignMap) campaigns.push(campaignMap[key]);
  return campaigns;
}

// =====================================================================
// 联盟链接
// =====================================================================
function fetchAffiliateLinks(campaigns) {
  if (!CONFIG.API_BASE_URL || !CONFIG.API_KEY) {
    console.log('联盟链接查询跳过: API 配置缺失。');
    return campaigns;
  }

  var toQuery = [];
  var campaignMap = {};
  for (var i = 0; i < campaigns.length; i++) {
    var c = campaigns[i];
    campaignMap[c.campaignId] = c;
    if (c.networkShortName && c.mid) {
      toQuery.push({ campaignId: c.campaignId, networkShortName: c.networkShortName,
        mid: c.mid, finalUrl: c.finalUrl || '' });
    }
  }

  if (toQuery.length === 0) {
    console.log('⚠️ 联盟链接查询跳过: 无有效广告系列名称。');
    return campaigns;
  }

  var batchSize = CONFIG.BATCH_SIZE || 100;
  var totalBatches = Math.ceil(toQuery.length / batchSize);
  console.log('查询 ' + toQuery.length + ' 个广告系列，分 ' + totalBatches + ' 批...');

  var totalFound = 0, totalNotFound = 0;
  for (var b = 0; b < totalBatches; b++) {
    if (shouldStop('联盟链接批次 #' + (b + 1))) {
      console.log('   查询中断，已完成 ' + b + '/' + totalBatches + ' 批次');
      break;
    }
    var batch = toQuery.slice(b * batchSize, Math.min((b + 1) * batchSize, toQuery.length));
    try {
      var result = callAffiliateLookupApi(batch);
      if (result && result.success && result.campaignResults) {
        for (var campaignId in result.campaignResults) {
          var info = result.campaignResults[campaignId];
          if (campaignMap[campaignId]) {
            if (info.found) {
              campaignMap[campaignId].trackingUrl = info.trackingUrl || '';
              campaignMap[campaignId].hasAffiliate = true;
              campaignMap[campaignId].status = 'ready';
              totalFound++;
            } else {
              campaignMap[campaignId].hasAffiliate = false;
              campaignMap[campaignId].status = 'no_affiliate';
              totalNotFound++;
            }
          }
        }
        if (result.stats) {
          console.log('   批次 #' + (b + 1) + ': 找到=' + result.stats.found + ', 未找到=' + result.stats.notFound);
        }
      }
    } catch (e) { console.log('   批次 #' + (b + 1) + ' 错误: ' + e.message); }
  }

  STATE.affiliateStats.found = totalFound;
  STATE.affiliateStats.notFound = totalNotFound;
  if (totalBatches > 1) console.log('联盟链接汇总: 找到=' + totalFound + ', 未找到=' + totalNotFound);
  if (totalFound === 0) console.log('⚠️ 警告: 无联盟链接！请检查后台数据或 Campaign 名称格式');
  return campaigns;
}

function callAffiliateLookupApi(campaignsBatch) {
  var url = CONFIG.API_BASE_URL.replace(/\\/$/, '') + '/api/v1/affiliate-links/lookup';
  return callApiWithRetry(url, {
    method: 'post', contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + CONFIG.API_KEY, 'X-Api-Key': CONFIG.API_KEY },
    payload: JSON.stringify({ campaigns: campaignsBatch }), muteHttpExceptions: true
  }, 3, 'Affiliate Lookup API');
}

// =====================================================================
// 写入表格
// =====================================================================
function writeToSheet(campaigns) {
  if (CONFIG.DRY_RUN) { console.log('[DRY_RUN] Sheet write skipped.'); return; }
  try {
    campaigns.sort(function(a, b) {
      var numA = parseInt((a.campaignName || '').substring(0, 3), 10);
      var numB = parseInt((b.campaignName || '').substring(0, 3), 10);
      if (isNaN(numA) && isNaN(numB)) return 0;
      if (isNaN(numA)) return 1;
      if (isNaN(numB)) return -1;
      return numB - numA;
    });
    var spreadsheet = SpreadsheetApp.openByUrl(CONFIG.SPREADSHEET_URL);
    var sheet = spreadsheet.getSheetByName(CONFIG.SHEET_NAME) ||
      spreadsheet.insertSheet(CONFIG.SHEET_NAME);
    if (CONFIG.CLEAR_BEFORE_WRITE) sheet.clear();
    sheet.getRange(1, 1, 1, COLUMN_HEADERS.length).setValues([COLUMN_HEADERS]);
    var headerRange = sheet.getRange(1, 1, 1, COLUMN_HEADERS.length);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#4285f4');
    headerRange.setFontColor('#ffffff');
    if (campaigns.length > 0) {
      var rows = [];
      for (var i = 0; i < campaigns.length; i++) {
        var c = campaigns[i];
        rows.push([c.campaignId, c.campaignName, c.country, c.finalUrl, c.todayClicks,
          c.cid, c.mccId, c.networkShortName, c.mid, c.trackingUrl,
          c.hasAffiliate ? 'YES' : 'NO', c.lastClicks, c.currentClicks,
          c.lastSuffix, c.lastApplyTime, c.status, c.updatedAt]);
      }
      sheet.getRange(2, 1, rows.length, COLUMN_HEADERS.length).setValues(rows);
    }
    sheet.setFrozenRows(1);
    console.log('表格写入成功: ' + campaigns.length + ' 行。');
  } catch (e) {
    console.log('表格写入失败: ' + e.message);
  }
}

// =====================================================================
// 循环监控
// =====================================================================
function initClicksState(campaigns) {
  var totalClicks = 0, withAffiliate = 0, withoutAffiliate = 0;
  for (var i = 0; i < campaigns.length; i++) {
    var c = campaigns[i];
    var timeZone = getAccountTimeZone(c.cid);
    var dateKey = getDateKey(new Date(), timeZone);
    c.lastClicks = c.todayClicks || 0;
    c.currentClicks = c.todayClicks || 0;
    c.lastClicksDate = dateKey;
    c.currentClicksDate = dateKey;
    STATE.campaignMap[c.campaignId] = c;
    totalClicks += c.todayClicks || 0;
    if (c.hasAffiliate) withAffiliate++; else withoutAffiliate++;
  }
  console.log('初始化: ' + campaigns.length + '系列(有链接' + withAffiliate +
    ' 无链接' + withoutAffiliate + ') 今日点击' + totalClicks);
}

function runMonitoringLoop(campaigns, mccId) {
  STATE.stats.monitoringStartTime = new Date();
  var pendingReports = [];
  var ngState = { count: 0, firstLoop: 0, firstElapsed: 0, lastRemaining: 0 };

  while (true) {
    if (shouldStop('监控循环 #' + (STATE.stats.loopCount + 1))) {
      flushNoGrowthLog(ngState);
      if (pendingReports.length > 0) {
        console.log('   [INTERRUPT] Reporting ' + pendingReports.length + ' pending results before stop...');
        callReportBatchApi(pendingReports);
        pendingReports = [];
      }
      break;
    }

    STATE.stats.loopCount++;

    if (STATE.stats.loopCount > 1) {
      var preSlpRemaining = getRemainingSeconds();
      var minCycleTime = CONFIG.LOOP_INTERVAL_SECONDS + 15;
      if (preSlpRemaining < minCycleTime) {
        flushNoGrowthLog(ngState);
        console.log('循环 #' + STATE.stats.loopCount + ' (' +
          Math.floor((new Date() - STATE.startTime) / 1000) + 's/' +
          Math.floor(preSlpRemaining) + 's) 时间不足，提前结束');
        if (pendingReports.length > 0) { callReportBatchApi(pendingReports); pendingReports = []; }
        break;
      }
      Utilities.sleep(CONFIG.LOOP_INTERVAL_SECONDS * 1000);
      if (shouldStop('监控循环 #' + STATE.stats.loopCount + ' sleep后')) {
        flushNoGrowthLog(ngState);
        if (pendingReports.length > 0) { callReportBatchApi(pendingReports); pendingReports = []; }
        break;
      }
    }

    refreshClickCounts(campaigns);

    var growth = [], clickGrowthCount = 0, noAffiliateCount = 0, clickDetails = [];
    for (var i = 0; i < campaigns.length; i++) {
      var c = campaigns[i];
      var increased = c.currentClicks > c.lastClicks;
      if (CONFIG.DEBUG_CLICKS && increased) {
        clickDetails.push(c.campaignName.substring(0, 20) + ': ' + c.lastClicks + '->' + c.currentClicks);
      }
      if (increased) {
        clickGrowthCount++;
        var allow = !CONFIG.ONLY_APPLY_WHEN_AFFILIATE_FOUND || !!c.hasAffiliate;
        if (allow) { growth.push(c); }
        else {
          noAffiliateCount++;
          console.log('   ⚠️ ' + c.campaignName + ': +' + (c.currentClicks - c.lastClicks) + ' clicks, but NO affiliate link (skipped)');
        }
      }
    }

    if (CONFIG.DEBUG_CLICKS && clickDetails.length > 0) {
      var sampledDetails = clickDetails.slice(0, CONFIG.DEBUG_CLICKS_SAMPLE_SIZE);
      if (clickDetails.length > CONFIG.DEBUG_CLICKS_SAMPLE_SIZE) {
        sampledDetails.push('... (另有 ' + (clickDetails.length - CONFIG.DEBUG_CLICKS_SAMPLE_SIZE) + ' 个)');
      }
      console.log('   [调试] 点击变化: ' + sampledDetails.join(' | '));
    }

    var loopElapsed = Math.floor((new Date() - STATE.startTime) / 1000);
    var loopRemaining = Math.floor(getRemainingSeconds());
    var loopTag = '循环 #' + STATE.stats.loopCount + ' (' + loopElapsed + 's/' + loopRemaining + 's)';

    if (clickGrowthCount === 0) {
      if (ngState.count === 0) { ngState.firstLoop = STATE.stats.loopCount; ngState.firstElapsed = loopElapsed; }
      ngState.count++;
      ngState.lastRemaining = loopRemaining;
      updateLastClicks(campaigns, true);
      continue;
    }

    var ngSuffix = buildNoGrowthSuffix(ngState);
    ngState.count = 0;

    if (growth.length === 0 && noAffiliateCount > 0) {
      STATE.stats.skippedNoAffiliate += noAffiliateCount;
      console.log(loopTag + ' ⚠️ ' + clickGrowthCount + ' 个增长但无联盟链接，已跳过' + ngSuffix);
      updateLastClicks(campaigns, true);
      continue;
    }

    if (noAffiliateCount > 0) STATE.stats.skippedNoAffiliate += noAffiliateCount;
    STATE.stats.clickGrowthLoops++;
    STATE.stats.clickGrowthCampaigns += growth.length;
    console.log(loopTag + ' 增长: ' + growth.length + ngSuffix);

    if (shouldStop('申请后缀前')) {
      flushNoGrowthLog(ngState);
      if (pendingReports.length > 0) { callReportBatchApi(pendingReports); pendingReports = []; }
      updateLastClicks(campaigns, true);
      break;
    }

    var leaseResults = callLeaseBatchApi(growth, mccId);
    var roundReports = [];

    for (var j = 0; j < leaseResults.length; j++) {
      if (j > 0 && j % CONFIG.TIME_CHECK_RESULTS_INTERVAL === 0 && shouldStop('处理后缀结果 #' + j)) {
        pendingReports = pendingReports.concat(roundReports);
        if (pendingReports.length > 0) { callReportBatchApi(pendingReports); pendingReports = []; }
        break;
      }

      var result = leaseResults[j];
      if (CONFIG.DEBUG_LEASE) {
        console.log('   [DEBUG] Result: campaignId=' + result.campaignId +
          ', action=' + result.action + ', hasSuffix=' + !!result.finalUrlSuffix +
          ', assignmentId=' + (result.assignmentId || 'none'));
      }

      var campaign = STATE.campaignMap[result.campaignId];
      if (!campaign) { console.log('   [警告] STATE 中未找到广告系列: ' + result.campaignId); continue; }

      var displayName = campaign.campaignName || campaign.campaignId || '';
      var clickInfo = campaign.lastClicks + '→' + campaign.currentClicks;

      if (result.action === 'APPLY' && result.finalUrlSuffix) {
        if (result.isIdempotent) {
          STATE.stats.noopCount++;
          console.log('   ♻️ 幂等: ' + displayName + ': ' + clickInfo + ' (已分配，跳过写入)');
          continue;
        }

        var stockStr = (typeof result.availableStock === 'number') ? ', 库存=' + result.availableStock : '';
        var stockWarning = (typeof result.availableStock === 'number' && result.availableStock <= 3) ? ' ⚠️' : '';

        if (typeof result.availableStock === 'number' && result.availableStock <= 3) {
          if (!STATE.stats.lowStockCampaigns[result.campaignId]) {
            STATE.stats.lowStockCampaigns[result.campaignId] = { name: displayName, stock: result.availableStock, count: 1 };
          } else {
            STATE.stats.lowStockCampaigns[result.campaignId].stock = result.availableStock;
            STATE.stats.lowStockCampaigns[result.campaignId].count++;
          }
        }

        if (CONFIG.DRY_RUN) {
          console.log('   [DRY] ' + displayName + ': ' + clickInfo + stockStr);
          campaign.lastSuffix = result.finalUrlSuffix;
          campaign.status = 'dry_run';
          continue;
        }

        var writeSuccess = false, writeErrorMessage = null;
        try {
          applySuffixToCampaign(campaign, result.finalUrlSuffix);
          campaign.lastSuffix = result.finalUrlSuffix;
          campaign.lastApplyTime = new Date().toISOString();
          campaign.status = 'applied';
          STATE.stats.suffixApplySuccess++;
          writeSuccess = true;
          console.log('   ✅ ' + displayName + ': ' + clickInfo + stockStr + stockWarning);
        } catch (e) {
          campaign.status = 'apply_failed';
          STATE.stats.suffixApplyFailed++;
          writeErrorMessage = e.message;
          console.log('   ❌ ' + displayName + ': ' + clickInfo + stockStr + ' | ' + e.message);
        }

        if (result.assignmentId) {
          roundReports.push({
            assignmentId: result.assignmentId, campaignId: result.campaignId,
            writeSuccess: writeSuccess, writeErrorMessage: writeErrorMessage,
            reportedAt: new Date().toISOString()
          });
        }

      } else if (result.action === 'NOOP') {
        STATE.stats.noopCount++;
        console.log('   ⏭️ NOOP: ' + displayName + ': ' + clickInfo + ' (' + (result.reason || 'unknown') + ')');
      } else if (result.code === 'NO_STOCK') {
        STATE.stats.noStockCount++;
        console.log('   ⚠️ NO_STOCK: ' + displayName + ': ' + clickInfo + ' -> 库存不足，请补货');
      } else if (result.code || result.message) {
        STATE.stats.apiErrorCount++;
        console.log('   ⚠️ ERROR: ' + displayName + ': ' + clickInfo + ' -> ' + (result.code || '') + ': ' + (result.message || ''));
      } else {
        STATE.stats.unknownResponseCount++;
        console.log('   ❓ UNKNOWN: ' + displayName + ': ' + clickInfo + ' -> ' + JSON.stringify(result).substring(0, 100));
      }
    }

    pendingReports = pendingReports.concat(roundReports);
    if (pendingReports.length > 0) {
      var reportOk = callReportBatchApi(pendingReports);
      if (!reportOk) console.log('   ⚠️ 本轮 ' + pendingReports.length + ' 条回传失败');
      pendingReports = [];
    }

    updateLastClicks(campaigns, true);
  }

  if (pendingReports.length > 0) {
    console.log('   [FINAL] Reporting ' + pendingReports.length + ' remaining results...');
    callReportBatchApi(pendingReports);
  }

  flushNoGrowthLog(ngState);
  STATE.stats.totalLoopTime = (new Date() - STATE.stats.monitoringStartTime) / 1000;
  console.log('循环结束。总循环次数: ' + STATE.stats.loopCount);
}

function refreshClickCounts(campaigns) {
  var campaignsByCid = {};
  for (var i = 0; i < campaigns.length; i++) {
    var c = campaigns[i];
    if (!campaignsByCid[c.cid]) campaignsByCid[c.cid] = [];
    campaignsByCid[c.cid].push(c.campaignId);
  }
  var cidList = Object.keys(campaignsByCid);
  var errorCount = 0;
  for (var idx = 0; idx < cidList.length; idx++) {
    var cid = cidList[idx];
    if (idx > 0 && idx % CONFIG.TIME_CHECK_CID_INTERVAL === 0 && shouldStop('刷新点击数 CID #' + idx)) break;
    var account = STATE.accountsByCid[cid];
    if (!account || !selectAccount(account, cid)) { errorCount++; continue; }
    var timeZone = getAccountTimeZone(cid);
    var currentDateKey = getDateKey(new Date(), timeZone);
    try {
      var rows = AdsApp.report(
        'SELECT campaign.id, metrics.clicks FROM campaign ' +
        'WHERE campaign.status = \\'ENABLED\\' AND segments.date DURING TODAY'
      ).rows();
      while (rows.hasNext()) {
        var row = rows.next();
        var campaignId = row['campaign.id'];
        if (STATE.campaignMap[campaignId]) {
          STATE.campaignMap[campaignId].currentClicks = parseInt(row['metrics.clicks'], 10) || 0;
          STATE.campaignMap[campaignId].currentClicksDate = currentDateKey;
        }
      }
    } catch (e) {
      console.log('   刷新点击数失败 CID ' + cid + ': ' + e.message);
      errorCount++;
    }
  }
  if (errorCount > 0) console.log('   刷新出错: ' + errorCount + ' 个 CID');
}

function updateLastClicks(campaigns, onlyIncrease) {
  for (var i = 0; i < campaigns.length; i++) {
    var c = campaigns[i];
    var isDayChanged = c.currentClicksDate && c.lastClicksDate && c.currentClicksDate !== c.lastClicksDate;
    if (isDayChanged && c.currentClicks < c.lastClicks) {
      console.log('   ⚠️ Day reset: ' + (c.campaignName || '').substring(0, 25) +
        ' ' + c.lastClicks + ' -> ' + c.currentClicks);
      c.lastClicks = c.currentClicks;
      c.lastClicksDate = c.currentClicksDate;
      continue;
    }
    if (onlyIncrease && c.currentClicks <= c.lastClicks) continue;
    c.lastClicks = c.currentClicks;
    c.lastClicksDate = c.currentClicksDate || c.lastClicksDate;
  }
}

function buildNoGrowthSuffix(ngState) {
  if (ngState.count === 0) return '';
  return ' | 前' + ngState.count + '轮无增长';
}

function flushNoGrowthLog(ngState) {
  if (ngState.count === 0) return;
  if (ngState.count === 1) {
    console.log('循环 #' + ngState.firstLoop + ' (' + ngState.firstElapsed + 's/' + ngState.lastRemaining + 's) 无增长');
  } else {
    var lastLoop = ngState.firstLoop + ngState.count - 1;
    console.log('循环 #' + ngState.firstLoop + '~#' + lastLoop + ' 无增长 ×' + ngState.count);
  }
  ngState.count = 0;
}

// =====================================================================
// 后缀申请与写入
// =====================================================================
function callApiWithRetry(url, options, maxRetries, apiName) {
  maxRetries = maxRetries || 3;
  apiName = apiName || 'API';
  var lastError = null;
  for (var attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      var response = UrlFetchApp.fetch(url, options);
      var code = response.getResponseCode();
      if (code === 200) {
        if (attempt > 1) console.log('   [重试成功] ' + apiName + ' 在第 ' + attempt + ' 次尝试成功');
        return JSON.parse(response.getContentText());
      }
      if (code >= 500 && code < 600 && attempt < maxRetries) {
        console.log('   [重试] ' + apiName + ' HTTP ' + code + ', 第 ' + attempt + '/' + maxRetries + ' 次');
        Utilities.sleep(1000 * attempt);
        continue;
      }
      throw new Error('HTTP ' + code + ': ' + response.getContentText().substring(0, 200));
    } catch (e) {
      lastError = e;
      var isNetworkError = e.message.indexOf('timeout') !== -1 ||
        e.message.indexOf('ETIMEDOUT') !== -1 || e.message.indexOf('ECONNRESET') !== -1 ||
        e.message.indexOf('ECONNREFUSED') !== -1 || e.message.indexOf('DNS') !== -1;
      if (isNetworkError && attempt < maxRetries) {
        console.log('   [重试] ' + apiName + ' 网络错误, 第 ' + attempt + '/' + maxRetries + ' 次');
        Utilities.sleep(1000 * attempt);
        continue;
      }
      if (attempt >= maxRetries) {
        console.log('   [重试失败] ' + apiName + ' 在 ' + maxRetries + ' 次尝试后失败: ' + e.message);
      }
      throw e;
    }
  }
  throw lastError;
}

function callLeaseBatchApi(campaigns, mccId) {
  var url = CONFIG.API_BASE_URL.replace(/\\/$/, '') + '/api/v1/suffix/lease/batch';
  var now = new Date();
  var windowStart = Math.floor(now.getTime() / 1000 / 60 / CONFIG.CYCLE_MINUTES) * CONFIG.CYCLE_MINUTES * 60;
  var allResults = [];
  var batches = chunkArray(campaigns, CONFIG.BATCH_SIZE || 100);

  for (var b = 0; b < batches.length; b++) {
    var payloadCampaigns = [];
    for (var i = 0; i < batches[b].length; i++) {
      var c = batches[b][i];
      payloadCampaigns.push({
        campaignId: c.campaignId, nowClicks: c.currentClicks, todayClicks: c.currentClicks,
        observedAt: now.toISOString(), windowStartEpochSeconds: windowStart,
        idempotencyKey: c.campaignId + ':' + c.currentClicks + ':' + windowStart,
        meta: { campaignName: c.campaignName, country: c.country, finalUrl: c.finalUrl,
          cid: c.cid, mccId: mccId }
      });
    }
    try {
      var data = callApiWithRetry(url, {
        method: 'post', contentType: 'application/json',
        headers: { 'Authorization': 'Bearer ' + CONFIG.API_KEY, 'X-Api-Key': CONFIG.API_KEY },
        payload: JSON.stringify({ campaigns: payloadCampaigns, scriptInstanceId: STATE.scriptInstanceId,
          cycleMinutes: CONFIG.CYCLE_MINUTES }),
        muteHttpExceptions: true
      }, 3, 'Lease Batch API #' + (b + 1));
      if (data && data.results && data.results.length > 0) {
        allResults = allResults.concat(data.results);
      }
    } catch (e) { console.log('Lease 批次 #' + (b + 1) + ' 重试后仍失败: ' + e.message); }
  }
  return allResults;
}

function callReportBatchApi(reports) {
  if (!reports || reports.length === 0) return true;
  var url = CONFIG.API_BASE_URL.replace(/\\/$/, '') + '/api/v1/suffix/report/batch';
  try {
    callApiWithRetry(url, {
      method: 'post', contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + CONFIG.API_KEY, 'X-Api-Key': CONFIG.API_KEY },
      payload: JSON.stringify({ reports: reports }), muteHttpExceptions: true
    }, 3, 'Report Batch API');
    return true;
  } catch (e) {
    console.log('   ❌ 回传失败(' + reports.length + '条): ' + e.message);
    return false;
  }
}

function applySuffixToCampaign(campaign, suffix) {
  suffix = suffix.replace(/^[#?&]+/, '').replace(/&+$/, '');
  if (!suffix) throw new Error('后缀清洗后为空，跳过写入');
  var account = STATE.accountsByCid[campaign.cid];
  if (!account) throw new Error('未找到账户 CID ' + campaign.cid);
  if (!selectAccount(account, campaign.cid)) throw new Error('切换账户失败 CID ' + campaign.cid);
  var campaignIterator = AdsApp.campaigns().withCondition('campaign.id = ' + campaign.campaignId).get();
  if (!campaignIterator.hasNext()) throw new Error('未找到广告系列: ' + campaign.campaignId);
  campaignIterator.next().urls().setFinalUrlSuffix(suffix);
}

// =====================================================================
// 工具函数
// =====================================================================
function selectAccount(account, expectedCid) {
  if (!account) return false;
  try {
    AdsManagerApp.select(account);
    return AdsApp.currentAccount().getCustomerId() === expectedCid;
  } catch (e) {
    console.log('   [错误] 切换账户失败 ' + expectedCid + ': ' + e.message);
    return false;
  }
}

function getAccountTimeZone(cid) {
  if (STATE.timeZoneByCid && STATE.timeZoneByCid[cid]) return STATE.timeZoneByCid[cid];
  var account = STATE.accountsByCid[cid];
  if (account && selectAccount(account, cid)) {
    var tz = AdsApp.currentAccount().getTimeZone();
    STATE.timeZoneByCid[cid] = tz;
    return tz;
  }
  return 'America/Los_Angeles';
}

function getDateKey(date, timeZone) {
  return Utilities.formatDate(date, timeZone, 'yyyy-MM-dd');
}

function chunkArray(list, size) {
  var result = [];
  var safeSize = Math.max(1, size || CONFIG.BATCH_SIZE);
  for (var i = 0; i < list.length; i += safeSize) result.push(list.slice(i, i + safeSize));
  return result;
}

function parseCampaignName(campaignName) {
  if (!campaignName) return { networkShortName: '', mid: '', parsed: false };
  var parts = campaignName.split('-');
  if (parts.length < 3) return { networkShortName: '', mid: '', parsed: false };
  var networkShortName = parts[1].trim().toUpperCase().replace(/[0-9]+$/, '');
  var mid = parts[parts.length - 1].trim();
  var isValid = CONFIG.VALID_NETWORKS.indexOf(networkShortName) !== -1 && mid.length > 0;
  return { networkShortName: isValid ? networkShortName : '', mid: isValid ? mid : '', parsed: isValid };
}

function generateInstanceId() {
  return 'inst_' + new Date().getTime() + '_' + Math.random().toString(36).substring(2, 8);
}

function formatDateTime(date, timeZone) {
  return Utilities.formatDate(date, timeZone, 'yyyy-MM-dd HH:mm:ss');
}

function formatDuration(seconds) {
  if (seconds < 60) return Math.floor(seconds) + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + Math.floor(seconds % 60) + 's';
  return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
}
`
}
