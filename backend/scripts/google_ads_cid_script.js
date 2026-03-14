/**
 * Google Ads MCC 脚本 — 每日自动同步 CID 列表到 Google Sheet
 *
 * ═══════════════════════════════════════════════════════════
 *  部署步骤（每个 MCC 账号各执行一次）
 * ═══════════════════════════════════════════════════════════
 *
 *  1. 打开 Google Ads → 选择 MCC 账号（顶部显示 MCC 名称）
 *  2. 左侧菜单 → 工具与设置 → 批量操作 → 脚本
 *  3. 点击 "+" 新建脚本
 *  4. 删掉默认代码，粘贴本文件全部内容
 *  5. 修改下方 SPREADSHEET_URL 为该 MCC 对应的 Google Sheet URL
 *     （和 DailyData 数据用的是同一个 Sheet 文件）
 *  6. 点击「预览」运行一次，确认日志显示 "已写入 XX 个子账号"
 *  7. 点击「运行频率」→ 每日 → 选择凌晨 3:00-4:00（在数据同步之前）
 *  8. 保存
 *
 *  完成后，每天系统同步数据时会自动从 CID_List 工作表读取最新的 CID 列表。
 * ═══════════════════════════════════════════════════════════
 */

// ★★★ 请替换为该 MCC 对应的 Google Sheet URL ★★★
var SPREADSHEET_URL = 'https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID_HERE/edit';

var CID_SHEET_NAME = 'CID_List';

function main() {
  var spreadsheet = SpreadsheetApp.openByUrl(SPREADSHEET_URL);

  // 获取或创建 CID_List 工作表
  var sheet = spreadsheet.getSheetByName(CID_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(CID_SHEET_NAME);
    Logger.log('已创建工作表: ' + CID_SHEET_NAME);
  }

  // 清空旧数据
  sheet.clear();

  // 表头
  var headers = ['CustomerID', 'AccountName', 'CurrencyCode', 'TimeZone'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  // 获取 MCC 下所有子账号（不切换账号，避免超时）
  var accounts = AdsManagerApp.accounts().get();
  var rows = [];

  while (accounts.hasNext()) {
    var account = accounts.next();
    rows.push([
      account.getCustomerId(),
      account.getName() || '',
      account.getCurrencyCode() || '',
      account.getTimeZone() || ''
    ]);
  }

  // 按 CID 排序
  rows.sort(function(a, b) {
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });

  // 批量写入
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }

  // 格式化
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  sheet.autoResizeColumns(1, headers.length);

  Logger.log('完成: 已写入 ' + rows.length + ' 个子账号 CID 到 ' + CID_SHEET_NAME);
}
