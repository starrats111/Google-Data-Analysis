/**
 * 生成统一 Google Ads 脚本（数据中心采集 + 换链接，一个脚本同时完成）
 *
 * 阶段0：采集近 30 天广告数据 / 子账号 CID / 广告系列信息，写入数据中心三张表
 *        （DailyData / CID_List / CampaignInfo），供 CRM 数据中心 sheet-sync 实时读取
 *        同时按月归档到 DailyData_YYYY-MM；首次运行会把 MCC 创建至今的历史一并补齐，
 *        进度记在 _BackfillMeta，单次跑不完下次自动接着补
 * 阶段1-5：扫描广告系列 → 查联盟链接 → 写监控表 → 点击监控 → lease/换链
 * 含 click-baseline 跨实例状态同步（启动时读取、退出前写入）
 *
 * @param apiKey       用户的 Script API Key（ky_live_xxx）
 * @param apiBaseUrl   CRM 后端地址，默认生产域名
 * @param sheetUrl     Google Sheet 链接（在个人 MCC 设置里统一配置）
 * @param mccId        MCC 客户ID（仅用于脚本头注释）
 * @param mccName      MCC 名称（仅用于脚本头注释）
 */
export function generateUnifiedAdsScript(
  apiKey: string,
  apiBaseUrl = 'https://google-data-analysis.top',
  sheetUrl = 'https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit',
  mccId?: string,
  mccName?: string
): string {
  const base = apiBaseUrl.replace(/\/$/, '')
  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })

  return `// Google Ads 统一脚本: 数据中心采集 + 联盟链接 + 点击监控换链
// MCC: ${mccName || '未命名'} (${mccId || '未设置'})
// 生成时间: ${ts}
//
// 一个脚本同时完成：
//   A. 数据中心：写 DailyData(近30天) / CID_List / CampaignInfo（供 CRM 实时读取分析）
//      并按月归档到 DailyData_YYYY-MM；首次运行自动补齐 MCC 创建至今的全部历史
//   B. 换链接：扫描广告系列 → 查联盟链接 → 点击监控 → 自动换 finalUrlSuffix

// ===== 配置区域 =====
var CONFIG = {
  // Google 表格配置（数据中心三张表 + 换链监控表共用一个表格）
  SPREADSHEET_URL: '${sheetUrl}',
  SHEET_NAME: '工作表1',
  CLEAR_BEFORE_WRITE: true,

  // API 配置（已自动填写）
  API_BASE_URL: '${base}',
  API_KEY: '${apiKey}',

  // 循环监控配置
  LOOP_INTERVAL_SECONDS: 15,
  CYCLE_MINUTES: 30,

  // 时间限制配置（Google Ads Script 最长运行 30 分钟）
  // 28 分钟 = 1680 秒，预留 2 分钟安全缓冲
  MAX_RUNTIME_SECONDS: 28 * 60,

  // 批量大小
  BATCH_SIZE: 100,

  // 数据中心采集（阶段0）
  ENABLE_DATA_CENTER_EXPORT: true,
  // 日常增量窗口：每次运行重新采集近 30 天并覆盖，确保 Google 事后回调修正
  // （转化、花费通常 T+2 内还会变）能被准确刷新
  DATA_CENTER_DAYS: 30,

  // 历史归档：首次运行把 MCC 创建至今的数据按月补齐到 DailyData_YYYY-MM，
  // 之后只维护近 30 天。进度存在表格 _BackfillMeta 里，跑不完下次自动接着补。
  ENABLE_HISTORY_BACKFILL: true,
  // 首次运行（还没有任何归档记录）时留给回补的时间，尽量一次补完
  BACKFILL_BUDGET_SECONDS_FIRST_RUN: 20 * 60,
  // 后续运行补剩余月份的时间，优先保证换链循环
  BACKFILL_BUDGET_SECONDS: 6 * 60,
  // 早于此月份一律不补，防止极端脏数据把回补拖成死循环
  BACKFILL_FLOOR_MONTH: '2024-01',
  // 连续多少个月完全没有数据就认为已到达账户起点
  BACKFILL_EMPTY_MONTH_TOLERANCE: 3,

  // 功能开关
  ENABLE_AFFILIATE_LOOKUP: true,
  ENABLE_SHEET_WRITE: true,
  ENABLE_SUFFIX_APPLY: true,
  ONLY_APPLY_WHEN_AFFILIATE_FOUND: true,
  // 首次主动换链：对「有联盟链接但当前无 finalUrlSuffix（从未换过）」的系列，
  // 在第一轮强制换上一次，之后回归点击增长轮换。解决新系列发布后还没点击时一直「未换」。
  ENABLE_PROACTIVE_FIRST_APPLY: true,
  DRY_RUN: false,

  // 调试开关
  DEBUG_CLICKS: false,
  DEBUG_CLICKS_SAMPLE_SIZE: 20,
  DEBUG_LEASE: false,

  // Campaign 名称解析配置
  VALID_NETWORKS: ['RW', 'LH', 'PM', 'LB', 'CG', 'CF', 'BSH', 'TJ', 'AW', 'MUI', 'EV'],

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

  // ===== 运行时配置：从 CRM 拉取可调参数（如轮询间隔），无需重新下发脚本即可调速 =====
  loadRuntimeConfig();

  // ===== 阶段 0: 数据中心采集（DailyData / CID_List / CampaignInfo）=====
  if (CONFIG.ENABLE_DATA_CENTER_EXPORT && !shouldStop('阶段0开始')) {
    console.log('===== 阶段0: 数据中心采集 =====');
    try {
      collectDataCenterSheets();
    } catch (e) {
      console.log('数据中心采集失败: ' + e.message);
    }
  }
  if (shouldStop('阶段0结束')) { logFinalReport(timeZone, []); return; }

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

  // ===== 新增: 首次主动换链 — 对有联盟链接但当前无后缀(从未换过)的系列，
  //        强制在第一轮触发一次换链；之后回归点击增长轮换 =====
  seedProactiveFirstApply(campaigns);

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
    if (!baseline) continue;

    // 换链系统是否下发过轮换后缀（用于「首次主动换链」判断，独立于点击基线新鲜度）
    if (typeof baseline.appliedBefore === 'boolean') c.crmApplied = baseline.appliedBefore;

    if (typeof baseline.clicks !== 'number') continue;

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
    'SELECT campaign.id, campaign.name, campaign.final_url_suffix FROM campaign WHERE campaign.status = \\'ENABLED\\''
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
      currentSuffix: row['campaign.final_url_suffix'] || '',
      crmApplied: false, // 换链系统是否下发过轮换后缀（来自 CRM，由 loadClickBaselines 回填）
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
// 阶段0: 数据中心采集
//
// 表结构：
//   DailyData            近 30 天滚动窗口，每次整表重写（现有 CRM 读取入口，格式不变）
//   DailyData_YYYY-MM    按月归档，长期保留 MCC 创建至今的全部历史
//   CID_List             子账号列表
//   CampaignInfo         广告系列信息
//   _BackfillMeta        归档进度（哪些月份已补齐），用于断点续跑
//
// 运行策略：
//   首次运行  —— 采集近 30 天 + 把 MCC 创建至今的历史按月补齐
//   之后每次  —— 只采集近 30 天，并把这 30 天精确合并回对应月份的归档表
//
// 精确度保证：
//   1. 近 30 天每次全部重新拉取并覆盖，Google 事后修正的转化/花费能被准确刷新
//   2. 归档表按「日期」逐行合并，只替换窗口内的日期，窗口外的历史原样保留，
//      跨月时不会把月初数据冲掉
//   3. 同一 (日期, 子账号, 广告系列) 只保留一行，重复写入自动去重
//   4. 日期一律用各子账号自己的时区换算，避免边界日错位
// =====================================================================
// D-264：末尾新增 ISBudget / ISRank / QS 三列（读操作全走 Sheet，替代服务端 API 拉取）。
// 只允许「追加」列，不许改动/插入前 13 列——CRM 按表头名解析，老表头兼容，
// 但归档表新旧行混存时靠固定列位对齐，改序会错位。
var DATA_HEADERS = ['Date', 'Account', 'AccountName', 'CampaignId', 'CampaignName', 'Status', 'Budget', 'Impressions', 'Clicks', 'Cost', 'Conversions', 'ConversionValue', 'Currency', 'ISBudget', 'ISRank', 'QS'];

/** 指标值透传：Google 没给的写空串，绝不写 0 冒充（CRM 侧空串按 NULL 处理） */
function metricOrBlank(v) {
  return (v === undefined || v === null || v === '' || v === '--') ? '' : v;
}
var BACKFILL_META_SHEET = '_BackfillMeta';
var BACKFILL_META_HEADERS = ['Month', 'Status', 'Rows', 'UpdatedAt', 'Source'];
var EARLIEST_META_KEY = '__EARLIEST__';

// ===== 月份工具：全部按 yyyy-MM 字符串处理，绕开时区与月末天数的坑 =====
function monthKeyOfDate(dateStr) {
  return (dateStr || '').toString().slice(0, 7);
}

function monthAdd(monthKey, delta) {
  var y = parseInt(monthKey.slice(0, 4), 10);
  var m = parseInt(monthKey.slice(5, 7), 10) - 1 + delta;
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  return y + '-' + ('0' + (m + 1)).slice(-2);
}

function monthLastDay(monthKey) {
  var y = parseInt(monthKey.slice(0, 4), 10);
  var m = parseInt(monthKey.slice(5, 7), 10);
  return monthKey + '-' + ('0' + new Date(y, m, 0).getDate()).slice(-2);
}

function currentMonthKey() {
  return Utilities.formatDate(new Date(), 'Asia/Shanghai', 'yyyy-MM');
}

/** 行去重键：同一天同一子账号同一系列只能有一行 */
function rowKeyOf(row) {
  return row[0] + '|' + row[1] + '|' + row[3];
}

// ===== 归档进度表 =====
function getBackfillMetaSheet(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(BACKFILL_META_SHEET);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(BACKFILL_META_SHEET);
    sheet.getRange(1, 1, 1, BACKFILL_META_HEADERS.length).setValues([BACKFILL_META_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readBackfillMeta(spreadsheet) {
  var meta = {};
  var sheet = spreadsheet.getSheetByName(BACKFILL_META_SHEET);
  if (!sheet) return meta;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return meta;
  var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  for (var i = 0; i < values.length; i++) {
    var key = (values[i][0] || '').toString().trim();
    if (key) meta[key] = (values[i][1] || '').toString().trim();
  }
  return meta;
}

function upsertBackfillMeta(spreadsheet, monthKey, status, rowCount, source) {
  var sheet = getBackfillMetaSheet(spreadsheet);
  var stamp = Utilities.formatDate(new Date(), 'Asia/Shanghai', 'yyyy-MM-dd HH:mm:ss');
  var newRow = [monthKey, status, rowCount, stamp, source];
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < keys.length; i++) {
      if ((keys[i][0] || '').toString().trim() === monthKey) {
        sheet.getRange(i + 2, 1, 1, newRow.length).setValues([newRow]);
        return;
      }
    }
  }
  sheet.getRange(lastRow + 1, 1, 1, newRow.length).setValues([newRow]);
}

// ===== 归档表读写 =====
function readMonthArchive(spreadsheet, monthKey) {
  var sheet = spreadsheet.getSheetByName('DailyData_' + monthKey);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, DATA_HEADERS.length).getValues();
}

function writeMonthArchive(spreadsheet, monthKey, rows) {
  var name = 'DailyData_' + monthKey;
  var sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, DATA_HEADERS.length).setValues([DATA_HEADERS]);
  if (rows.length > 0) sheet.getRange(2, 1, rows.length, DATA_HEADERS.length).setValues(rows);
  sheet.setFrozenRows(1);
}

/**
 * 把新采集到的行精确合并进某个月的归档表。
 * 只有落在 [windowStart, windowEnd] 内的旧行会被替换，窗口外的历史原样保留，
 * 因此跨月运行（例如 9/2 采集 8/3~9/2）不会把 8/1-8/2 冲掉。
 * windowStart 传空表示整月替换（历史回补场景）。
 */
function mergeMonthArchive(spreadsheet, monthKey, freshRows, windowStart, windowEnd) {
  var merged = [];
  var seen = {};

  for (var i = 0; i < freshRows.length; i++) {
    var key = rowKeyOf(freshRows[i]);
    if (seen[key]) continue;
    seen[key] = true;
    merged.push(freshRows[i]);
  }

  if (windowStart) {
    var existing = readMonthArchive(spreadsheet, monthKey);
    for (var j = 0; j < existing.length; j++) {
      var date = (existing[j][0] || '').toString().slice(0, 10);
      if (!date) continue;
      // 窗口内的旧数据已被本次采集覆盖，丢弃；窗口外的保留
      if (date >= windowStart && date <= windowEnd) continue;
      var k = rowKeyOf(existing[j]);
      if (seen[k]) continue;
      seen[k] = true;
      merged.push(existing[j]);
    }
  }

  merged.sort(function (a, b) {
    var da = (a[0] || '').toString();
    var db = (b[0] || '').toString();
    return da < db ? -1 : da > db ? 1 : 0;
  });

  writeMonthArchive(spreadsheet, monthKey, merged);
  return merged.length;
}

// ===== 报表采集 =====
/**
 * 拉取指定日期区间内所有子账号的广告系列日报。
 * IS 两列是历史有效指标，回补/归档同样采集；QS 只有「当前值」没有历史维度，
 * 历史回补行写空串（不臆造），近 7 天由 collectQsForAccount 在主采集时填充。
 */
function fetchRangeForAccounts(accounts, startDate, endDate, phaseLabel) {
  var rows = [];
  for (var i = 0; i < accounts.length; i++) {
    if (shouldStop(phaseLabel)) break;
    AdsManagerApp.select(accounts[i]);
    try {
      var report = AdsApp.report(
        "SELECT segments.date, customer.id, customer.descriptive_name, campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, customer.currency_code, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share FROM campaign WHERE segments.date BETWEEN '" + startDate + "' AND '" + endDate + "'"
      );
      var it = report.rows();
      while (it.hasNext()) {
        var r = it.next();
        rows.push([r['segments.date'], r['customer.id'], r['customer.descriptive_name'], r['campaign.id'], r['campaign.name'], r['campaign.status'], r['campaign_budget.amount_micros'], r['metrics.impressions'], r['metrics.clicks'], r['metrics.cost_micros'], r['metrics.conversions'], r['metrics.conversions_value'], r['customer.currency_code'], metricOrBlank(r['metrics.search_budget_lost_impression_share']), metricOrBlank(r['metrics.search_rank_lost_impression_share']), '']);
      }
    } catch (e) {
      console.log('   数据采集错误 ' + accounts[i].getName() + ': ' + e.message);
    }
  }
  return rows;
}

/**
 * 采集当前账号近 7 天的 campaign 级 QS（keyword_view 当前 QS 按当日点击加权，
 * 无点击退化为简单平均，口径与原服务端 D-238 完全一致）。
 * 返回 { 'yyyy-MM-dd|campaignId': qs }；采集失败返回空表（QS 列留空，不阻塞主采集）。
 */
function collectQsForAccount(tz) {
  var map = {};
  try {
    var endD = new Date();
    var startD = new Date();
    startD.setDate(startD.getDate() - 7);
    var qsStart = Utilities.formatDate(startD, tz, 'yyyy-MM-dd');
    var qsEnd = Utilities.formatDate(endD, tz, 'yyyy-MM-dd');
    var report = AdsApp.report(
      "SELECT campaign.id, segments.date, metrics.clicks, ad_group_criterion.quality_info.quality_score FROM keyword_view WHERE segments.date BETWEEN '" + qsStart + "' AND '" + qsEnd + "' AND ad_group_criterion.status != 'REMOVED'"
    );
    var acc = {};
    var it = report.rows();
    while (it.hasNext()) {
      var r = it.next();
      var qs = parseFloat(r['ad_group_criterion.quality_info.quality_score']);
      if (!qs || qs <= 0) continue;
      var clicks = parseFloat(r['metrics.clicks']) || 0;
      var key = r['segments.date'] + '|' + r['campaign.id'];
      var a = acc[key] || { weighted: 0, clicks: 0, plain: 0, count: 0 };
      a.weighted += qs * clicks;
      a.clicks += clicks;
      a.plain += qs;
      a.count += 1;
      acc[key] = a;
    }
    for (var k in acc) {
      var a2 = acc[k];
      var v = a2.clicks > 0 ? a2.weighted / a2.clicks : a2.plain / a2.count;
      map[k] = Math.round(v * 10) / 10;
    }
  } catch (e) {
    console.log('   QS 采集错误（该账号 QS 列留空）: ' + e.message);
  }
  return map;
}

function collectDataCenterSheets() {
  var spreadsheet = SpreadsheetApp.openByUrl(CONFIG.SPREADSHEET_URL);

  var accounts = [];
  var accountIterator = AdsManagerApp.accounts().get();
  while (accountIterator.hasNext()) accounts.push(accountIterator.next());
  if (accounts.length === 0) {
    console.log('   MCC 下没有子账号，跳过采集');
    return;
  }

  var allRows = [];
  var cidRows = [];
  var campaignInfoRows = [];
  var windowStart = '';
  var windowEnd = '';

  for (var i = 0; i < accounts.length; i++) {
    if (shouldStop('数据中心采集')) break;
    var account = accounts[i];
    cidRows.push([account.getCustomerId(), account.getName() || '']);
    AdsManagerApp.select(account);

    // 按子账号自己的时区算窗口，避免跨时区账号的边界日被算错
    var tz = AdsApp.currentAccount().getTimeZone();
    var startD = new Date();
    startD.setDate(startD.getDate() - (CONFIG.DATA_CENTER_DAYS || 30));
    var endDate = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    var startDate = Utilities.formatDate(startD, tz, 'yyyy-MM-dd');
    // 各账号时区不同，取并集才能覆盖全部被本次刷新的日期
    if (!windowStart || startDate < windowStart) windowStart = startDate;
    if (!windowEnd || endDate > windowEnd) windowEnd = endDate;

    // 近 7 天 QS（当前值按当日点击加权），主报表逐行按 (日期|系列) 匹配填入
    var qsMap = collectQsForAccount(tz);

    try {
      var report = AdsApp.report(
        "SELECT segments.date, customer.id, customer.descriptive_name, campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, customer.currency_code, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share FROM campaign WHERE segments.date BETWEEN '" + startDate + "' AND '" + endDate + "'"
      );
      var rows = report.rows();
      while (rows.hasNext()) {
        var row = rows.next();
        var qsKey = row['segments.date'] + '|' + row['campaign.id'];
        allRows.push([row['segments.date'], row['customer.id'], row['customer.descriptive_name'], row['campaign.id'], row['campaign.name'], row['campaign.status'], row['campaign_budget.amount_micros'], row['metrics.impressions'], row['metrics.clicks'], row['metrics.cost_micros'], row['metrics.conversions'], row['metrics.conversions_value'], row['customer.currency_code'], metricOrBlank(row['metrics.search_budget_lost_impression_share']), metricOrBlank(row['metrics.search_rank_lost_impression_share']), qsMap.hasOwnProperty(qsKey) ? qsMap[qsKey] : '']);
      }
    } catch (e) { console.log('   数据采集错误 ' + account.getName() + ': ' + e.message); }

    try {
      var infoReport = AdsApp.report(
        "SELECT campaign.id, campaign.name, campaign.status, campaign.start_date_time, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED'"
      );
      var infoRows = infoReport.rows();
      while (infoRows.hasNext()) {
        var infoRow = infoRows.next();
        var startDt = infoRow['campaign.start_date_time'] || '';
        var creationDateCST = '';
        if (startDt) {
          try {
            var parsedDt = Utilities.parseDate(startDt, tz, 'yyyy-MM-dd HH:mm:ss');
            creationDateCST = Utilities.formatDate(parsedDt, 'Asia/Shanghai', 'yyyy-MM-dd');
          } catch (pe) {
            creationDateCST = startDt.slice(0, 10);
          }
        }
        campaignInfoRows.push([infoRow['campaign.id'], infoRow['campaign.name'], infoRow['campaign.status'], creationDateCST, account.getCustomerId(), metricOrBlank(infoRow['campaign_budget.amount_micros'])]);
      }
    } catch (e) { console.log('   CampaignInfo 采集错误 ' + account.getName() + ': ' + e.message); }
  }

  var sheet = spreadsheet.getSheetByName('DailyData') || spreadsheet.insertSheet('DailyData');
  sheet.clearContents();
  sheet.getRange(1, 1, 1, DATA_HEADERS.length).setValues([DATA_HEADERS]);
  if (allRows.length > 0) sheet.getRange(2, 1, allRows.length, DATA_HEADERS.length).setValues(allRows);
  sheet.setFrozenRows(1);
  console.log('   DailyData: ' + allRows.length + ' 行 (' + windowStart + ' ~ ' + windowEnd + ')');

  archiveRecentWindow(spreadsheet, allRows, windowStart, windowEnd);

  var cidSheet = spreadsheet.getSheetByName('CID_List') || spreadsheet.insertSheet('CID_List');
  cidSheet.clearContents();
  cidSheet.getRange(1, 1, 1, 2).setValues([['CustomerID', 'AccountName']]);
  cidRows.sort(function(a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
  if (cidRows.length > 0) cidSheet.getRange(2, 1, cidRows.length, 2).setValues(cidRows);
  cidSheet.setFrozenRows(1);
  console.log('   CID_List: ' + cidRows.length + ' 账号');

  var infoSheet = spreadsheet.getSheetByName('CampaignInfo') || spreadsheet.insertSheet('CampaignInfo');
  // D-264：新增 Budget 列（micros，账户币种）。零花费/停投系列 DailyData 不落行，
  // 预算回写全靠这张全量清单，缺了它这类系列的预算永远停在建单初值。
  var infoHeaders = ['CampaignId', 'CampaignName', 'Status', 'CreationDateCST', 'CustomerId', 'Budget'];
  infoSheet.clearContents();
  infoSheet.getRange(1, 1, 1, infoHeaders.length).setValues([infoHeaders]);
  if (campaignInfoRows.length > 0) infoSheet.getRange(2, 1, campaignInfoRows.length, infoHeaders.length).setValues(campaignInfoRows);
  infoSheet.setFrozenRows(1);
  console.log('   CampaignInfo: ' + campaignInfoRows.length + ' 广告系列');

  if (CONFIG.ENABLE_HISTORY_BACKFILL) {
    try {
      runHistoryBackfill(spreadsheet, accounts, campaignInfoRows);
    } catch (e) {
      console.log('   历史回补失败: ' + e.message);
    }
  }
}

/** 把近 30 天窗口的数据精确合并进对应月份的归档表 */
function archiveRecentWindow(spreadsheet, allRows, windowStart, windowEnd) {
  if (allRows.length === 0 || !windowStart) return;
  // 采集被时间上限打断时，allRows 只有部分子账号的数据。此时合并会把窗口内
  // 「本次没轮到的账号」的历史行删掉，宁可这轮不归档，下次跑完整的再写。
  if (STATE.forceStopped) {
    console.log('   月度归档: 本轮采集被中断，跳过归档以免删掉未采集账号的历史');
    return;
  }

  var byMonth = {};
  for (var i = 0; i < allRows.length; i++) {
    var key = monthKeyOfDate(allRows[i][0]);
    if (!key) continue;
    if (!byMonth[key]) byMonth[key] = [];
    byMonth[key].push(allRows[i]);
  }

  var thisMonth = currentMonthKey();
  var written = [];
  for (var monthKey in byMonth) {
    if (!byMonth.hasOwnProperty(monthKey)) continue;
    try {
      var count = mergeMonthArchive(spreadsheet, monthKey, byMonth[monthKey], windowStart, windowEnd);
      written.push(monthKey + '(' + count + ')');

      // 进度标记要谨慎：30 天窗口的最前面那个月是残缺的（8/3 运行时窗口从 7/4 开始，
      // 7/1-7/3 没采到），不能标 complete，否则历史回补会跳过它，留下永久缺口。
      // 已被回补补全过的月份也不在这里降级，避免每天重复补同一个月。
      var status = '';
      if (monthKey === thisMonth) status = 'current';
      else if ((monthKey + '-01') >= windowStart) status = 'complete';
      if (status) upsertBackfillMeta(spreadsheet, monthKey, status, count, 'daily');
    } catch (e) {
      console.log('   月度归档失败 ' + monthKey + ': ' + e.message);
    }
  }
  console.log('   月度归档: ' + (written.length ? written.join(' ') : '无'));
}

// =====================================================================
// 历史回补：把 MCC 创建至今、30 天窗口够不到的月份按月补齐
// 进度写在 _BackfillMeta，单次跑不完下次运行自动接着补
// =====================================================================

/** 用各子账号最早的广告系列开始时间推出 MCC 真实起点，结果缓存进 _BackfillMeta */
function detectEarliestMonth(spreadsheet, accounts, campaignInfoRows) {
  var meta = readBackfillMeta(spreadsheet);
  var cached = meta[EARLIEST_META_KEY];
  if (cached && cached.length === 7 && cached.charAt(4) === '-') return cached;

  var earliest = '';
  // 阶段0 已经采过 CampaignInfo（含创建日），优先复用，省掉一轮全账号查询
  for (var i = 0; i < campaignInfoRows.length; i++) {
    var d = (campaignInfoRows[i][3] || '').toString().slice(0, 10);
    if (d.length === 10 && (!earliest || d < earliest)) earliest = d;
  }

  // CampaignInfo 排除了 REMOVED，早期已删的系列可能让起点被高估，再查一次全量兜底
  for (var j = 0; j < accounts.length; j++) {
    if (shouldStop('起点探测')) break;
    AdsManagerApp.select(accounts[j]);
    try {
      var report = AdsApp.report('SELECT campaign.id, campaign.start_date_time FROM campaign');
      var it = report.rows();
      while (it.hasNext()) {
        var raw = (it.next()['campaign.start_date_time'] || '').toString().slice(0, 10);
        if (raw.length === 10 && (!earliest || raw < earliest)) earliest = raw;
      }
    } catch (e) {
      console.log('   起点探测失败 ' + accounts[j].getName() + ': ' + e.message);
    }
  }

  var result = earliest ? earliest.slice(0, 7) : CONFIG.BACKFILL_FLOOR_MONTH;
  if (result < CONFIG.BACKFILL_FLOOR_MONTH) result = CONFIG.BACKFILL_FLOOR_MONTH;
  // 探测被打断时只扫了部分账号，起点可能偏晚。这轮先用着，但不写缓存，
  // 否则一个偏晚的起点会被永久固化，更早的历史再也补不回来。
  if (!STATE.forceStopped) {
    upsertBackfillMeta(spreadsheet, EARLIEST_META_KEY, result, 0, 'detect');
  }
  console.log('   历史起点: ' + result + '（最早广告系列 ' + (earliest || '未知') + '）');
  return result;
}

function runHistoryBackfill(spreadsheet, accounts, campaignInfoRows) {
  var meta = readBackfillMeta(spreadsheet);
  var isFirstRun = !meta[EARLIEST_META_KEY];
  var budget = isFirstRun ? CONFIG.BACKFILL_BUDGET_SECONDS_FIRST_RUN : CONFIG.BACKFILL_BUDGET_SECONDS;

  // 换链循环是主职责，回补只能用富余时间
  var usable = Math.min(budget, getRemainingSeconds() - 120);
  if (usable < 60) {
    console.log('   历史回补: 剩余时间不足，留到下次运行');
    return;
  }

  var earliestMonth = detectEarliestMonth(spreadsheet, accounts, campaignInfoRows);
  meta = readBackfillMeta(spreadsheet);

  // 从上个月往前推；当月由每次的 30 天窗口维护，不归回补管
  var pending = [];
  var cursor = monthAdd(currentMonthKey(), -1);
  while (cursor >= earliestMonth) {
    if (meta[cursor] !== 'complete') pending.push(cursor);
    cursor = monthAdd(cursor, -1);
  }

  if (pending.length === 0) {
    console.log('   历史回补: 已全部补齐（' + earliestMonth + ' 至今）');
    return;
  }
  console.log('   历史回补: 待补 ' + pending.length + ' 个月，本次预算 ' + Math.floor(usable) + ' 秒');

  var deadline = new Date().getTime() + usable * 1000;
  var done = 0;
  var consecutiveEmpty = 0;

  for (var i = 0; i < pending.length; i++) {
    if (new Date().getTime() >= deadline || shouldStop('历史回补')) {
      console.log('   历史回补: 本次补了 ' + done + ' 个月，剩 ' + (pending.length - i) + ' 个月下次继续');
      return;
    }

    var monthKey = pending[i];
    var rows = fetchRangeForAccounts(accounts, monthKey + '-01', monthLastDay(monthKey), '历史回补 ' + monthKey);

    // 该月只采到一部分子账号就撞上运行时上限。绝不能标记为已完成，
    // 否则这个残缺月永远不会被重补，留下永久缺口。
    if (STATE.forceStopped) {
      console.log('   ' + monthKey + ' 采集中断，不写入也不标记完成，下次重来');
      return;
    }

    // 整月替换（不传窗口），空月不建表，避免账号存在期之前留下一堆空表
    var count = rows.length > 0 ? mergeMonthArchive(spreadsheet, monthKey, rows, '', '') : 0;
    upsertBackfillMeta(spreadsheet, monthKey, 'complete', count, 'backfill');
    done++;
    console.log('   ' + monthKey + ': ' + count + ' 行');

    if (count === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= CONFIG.BACKFILL_EMPTY_MONTH_TOLERANCE) {
        // 抬高起点并落盘，否则以后每次运行都会重扫这些不存在的月份
        upsertBackfillMeta(spreadsheet, EARLIEST_META_KEY, monthKey, 0, 'detect');
        console.log('   历史回补: 连续 ' + consecutiveEmpty + ' 个月无数据，已到账号起点，收敛到 ' + monthKey);
        return;
      }
    } else {
      consecutiveEmpty = 0;
    }
  }

  console.log('   历史回补: 本次补了 ' + done + ' 个月，历史已全部补齐');
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

// =====================================================================
// 首次主动换链：把「有联盟链接 + 换链系统从未下发过轮换后缀」的系列
// 的 lastClicks 置为 -1，使其在第一轮监控即被判定为「增长」从而换上一次链接。
// 换上后 updateLastClicks 会把 lastClicks 归位到当前点击数，之后仅按真实点击增长轮换，
// 不会重复换。
//
// 重要：判断「是否换过」必须用 CRM 的 crmApplied(=suffix_last_apply_at)，
// 不能用 Google 端 currentSuffix(final_url_suffix) 是否为空 —— 系列发布时已写入
// 原始联盟追踪后缀(utm/irclickid 等)，currentSuffix 永远非空，否则 seed 永远跳过，
// 导致「发布后还没点击」的系列一直换不上。
// =====================================================================
function seedProactiveFirstApply(campaigns) {
  if (!CONFIG.ENABLE_PROACTIVE_FIRST_APPLY) return;
  if (CONFIG.ONLY_APPLY_WHEN_AFFILIATE_FOUND === false) {
    // 未开启「仅有联盟链接才换」时，无法可靠判断该不该主动换，保守跳过
    return;
  }
  var seeded = 0;
  for (var i = 0; i < campaigns.length; i++) {
    var c = campaigns[i];
    if (c.hasAffiliate && !c.crmApplied) {
      c.lastClicks = -1; // 制造一次「增长」，首轮即换链
      seeded++;
    }
  }
  if (seeded > 0) {
    console.log('首次主动换链: ' + seeded + ' 个有链接但换链系统未下发过后缀的系列将在首轮换上');
  }
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
// 运行时配置（服务端可调，避免为调参反复重发脚本）
// =====================================================================
function loadRuntimeConfig() {
  try {
    var url = CONFIG.API_BASE_URL.replace(/\\/$/, '') + '/api/v1/suffix/script-config';
    var data = callApiWithRetry(url, {
      method: 'get',
      headers: { 'Authorization': 'Bearer ' + CONFIG.API_KEY, 'X-Api-Key': CONFIG.API_KEY },
      muteHttpExceptions: true
    }, 2, 'Script Config API');
    if (data && data.success && data.config) {
      var li = parseInt(data.config.loopIntervalSeconds, 10);
      if (!isNaN(li) && li >= 5 && li <= 300) CONFIG.LOOP_INTERVAL_SECONDS = li;
      var cm = parseInt(data.config.cycleMinutes, 10);
      if (!isNaN(cm) && cm >= 5 && cm <= 60) CONFIG.CYCLE_MINUTES = cm;
      console.log('运行时配置: 轮询' + CONFIG.LOOP_INTERVAL_SECONDS + 's | 周期' + CONFIG.CYCLE_MINUTES + 'min');
    }
  } catch (e) {
    console.log('运行时配置拉取失败, 使用脚本内默认: 轮询' + CONFIG.LOOP_INTERVAL_SECONDS + 's (' + e.message + ')');
  }
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

/** @deprecated 使用 generateUnifiedAdsScript；保留别名向后兼容 */
export const generateLinkExchangeScript = generateUnifiedAdsScript
