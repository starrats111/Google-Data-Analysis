/**
 * Google Ads MCC 脚本：将所有子账号 CID 写入 Google Sheet
 * 
 * 使用方法：
 * 1. 在 Google Ads MCC 账号中打开「工具与设置 → 脚本」
 * 2. 新建脚本，粘贴此代码
 * 3. 将 SPREADSHEET_URL 替换为你的 Google Sheet URL（与 DailyData 同一个 Sheet 文件）
 * 4. 运行一次确认正常，然后设置每日定时执行
 * 
 * 脚本会在 Sheet 中创建/更新名为 "CID_List" 的工作表，
 * 写入所有子账号的 CID、名称和状态。
 */

var SPREADSHEET_URL = 'YOUR_SHEET_URL_HERE'; // 替换为实际 URL
var SHEET_NAME = 'CID_List';

function main() {
  var spreadsheet = SpreadsheetApp.openByUrl(SPREADSHEET_URL);
  
  // 获取或创建 CID_List 工作表
  var sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
  }
  
  // 清空旧数据
  sheet.clear();
  
  // 写入表头
  sheet.appendRow(['CustomerID', 'AccountName', 'Status']);
  
  // 遍历 MCC 下所有子账号
  var accountIterator = AdsManagerApp.accounts().get();
  var rows = [];
  
  while (accountIterator.hasNext()) {
    var account = accountIterator.next();
    var customerId = account.getCustomerId(); // 格式: xxx-xxx-xxxx
    var name = account.getName() || '';
    
    // 检查该账号是否有正在投放的广告系列
    AdsManagerApp.select(account);
    var campaignIterator = AdsApp.campaigns()
      .withCondition('Status = ENABLED')
      .get();
    var status = campaignIterator.hasNext() ? 'ACTIVE' : 'IDLE';
    
    rows.push([customerId, name, status]);
  }
  
  // 批量写入
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 3).setValues(rows);
  }
  
  Logger.log('已写入 ' + rows.length + ' 个子账号 CID');
}
