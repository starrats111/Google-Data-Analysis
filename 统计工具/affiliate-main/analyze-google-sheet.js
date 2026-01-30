// Google Sheets CSV 结构分析脚本
const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));

async function analyzeGoogleSheet() {
  try {
    console.log('\n=== 📊 Google Sheets CSV 结构分析 ===\n');

    // 1. 从数据库获取已配置的表格
    const sheets = db.prepare('SELECT * FROM google_sheets').all();

    if (sheets.length === 0) {
      console.log('❌ 数据库中没有配置的Google表格');
      return;
    }

    console.log(`✅ 找到 ${sheets.length} 个已配置的表格\n`);

    // 分析每个表格
    for (const sheet of sheets) {
      console.log(`\n${'='.repeat(80)}`);
      console.log(`📋 表格名称: ${sheet.sheet_name}`);
      console.log(`🔗 表格ID: ${sheet.sheet_id}`);
      console.log(`🆔 数据库ID: ${sheet.id}`);
      console.log(`${'='.repeat(80)}\n`);

      // 2. 构建CSV导出URL
      const csvUrl = `https://docs.google.com/spreadsheets/d/${sheet.sheet_id}/export?format=csv&gid=0`;
      console.log(`📥 正在下载CSV数据...`);
      console.log(`   URL: ${csvUrl}\n`);

      try {
        // 3. 下载CSV数据
        const response = await axios.get(csvUrl, {
          timeout: 10000,
          maxRedirects: 5,
        });

        const csvData = response.data;
        const lines = csvData.split('\n');

        console.log(`✅ 下载成功！共 ${lines.length} 行数据\n`);

        // 4. 显示前10行原始数据
        console.log('【前10行原始CSV数据】');
        console.log('-'.repeat(80));
        lines.slice(0, 10).forEach((line, index) => {
          if (line.trim()) {
            console.log(`第 ${index + 1} 行: ${line.substring(0, 150)}${line.length > 150 ? '...' : ''}`);
          }
        });
        console.log('-'.repeat(80));

        // 5. 解析并分析数据结构
        console.log('\n【数据结构分析】\n');

        // 假设第1行是表头
        const headerLine = lines[0];
        if (headerLine) {
          const headers = headerLine.split(',').map(h => h.trim().replace(/^"|"$/g, ''));
          console.log('📌 表头（第1行）:');
          headers.forEach((header, index) => {
            console.log(`   列 ${index}: "${header}"`);
          });
        }

        // 显示第2行
        console.log('\n📌 第2行数据:');
        if (lines[1]) {
          const row2 = lines[1].split(',').map(f => f.trim().replace(/^"|"$/g, ''));
          row2.forEach((field, index) => {
            console.log(`   列 ${index}: "${field}"`);
          });
        }

        // 显示第3行（通常这里开始是真实数据）
        console.log('\n📌 第3行数据（通常是第一条真实数据）:');
        if (lines[2]) {
          const row3 = lines[2].split(',').map(f => f.trim().replace(/^"|"$/g, ''));
          row3.forEach((field, index) => {
            console.log(`   列 ${index}: "${field}"`);
          });
        }

        // 显示第4行
        console.log('\n📌 第4行数据:');
        if (lines[3]) {
          const row4 = lines[3].split(',').map(f => f.trim().replace(/^"|"$/g, ''));
          row4.forEach((field, index) => {
            console.log(`   列 ${index}: "${field}"`);
          });
        }

        // 6. 智能分析建议
        console.log('\n【🤖 智能分析建议】\n');

        if (lines.length >= 3) {
          const row3 = lines[2].split(',').map(f => f.trim().replace(/^"|"$/g, ''));

          console.log('根据数据特征推测：\n');

          row3.forEach((field, index) => {
            let guess = '未知类型';

            // 判断是否是日期
            if (/^\d{4}-\d{2}-\d{2}$/.test(field)) {
              guess = '🗓️  日期格式 (YYYY-MM-DD)';
            } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(field)) {
              guess = '🗓️  日期格式 (MM/DD/YYYY)';
            } else if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(field)) {
              guess = '🗓️  日期格式 (可能)';
            }
            // 判断是否是数字
            else if (/^\d+$/.test(field)) {
              guess = '🔢 整数';
            } else if (/^\d+\.\d+$/.test(field)) {
              guess = '💰 小数/金额';
            }
            // 判断是否是货币代码
            else if (/^[A-Z]{3}$/.test(field)) {
              guess = '💵 货币代码 (如USD, EUR)';
            }
            // 判断是否是URL
            else if (/^https?:\/\//.test(field)) {
              guess = '🔗 URL链接';
            }
            // 判断是否包含国家名
            else if (/United States|Canada|France|Germany|Italy|United Kingdom|Australia/i.test(field)) {
              guess = '🌍 国家/地区名称';
            }
            // 判断是否是ID格式
            else if (/^\d+-[a-z0-9]+-/.test(field)) {
              guess = '🆔 ID格式 (可能是广告系列ID或商家ID)';
            }
            // 其他文本
            else if (field.length > 0) {
              guess = '📝 文本';
            }

            console.log(`   列 ${index}: ${guess.padEnd(35)} 示例: "${field.substring(0, 40)}${field.length > 40 ? '...' : ''}"`);
          });
        }

        // 7. 对比当前代码的假设
        console.log('\n【⚠️  当前代码假设 vs 实际情况】\n');
        console.log('当前代码假设的列映射：');
        console.log('   列 0 → 广告系列名 (campaign_name)');
        console.log('   列 3 → 广告系列预算 (budget)');
        console.log('   列 4 → 货币 (currency)');
        console.log('   列 7 → 日期 (date)');
        console.log('   列 8 → 展示次数 (impressions)');
        console.log('   列 9 → 点击次数 (clicks)');
        console.log('   列 10 → 花费 (cost)');

        console.log('\n实际写入数据库的数据（从google_ads_data表）：');
        const actualData = db
          .prepare('SELECT * FROM google_ads_data WHERE sheet_id = ? LIMIT 3')
          .all(sheet.id);

        if (actualData.length > 0) {
          actualData.forEach((row, index) => {
            console.log(`\n   记录 ${index + 1}:`);
            console.log(`      date: "${row.date}"`);
            console.log(`      campaign_name: "${row.campaign_name}"`);
            console.log(`      budget: ${row.campaign_budget}`);
            console.log(`      currency: "${row.currency}"`);
            console.log(`      impressions: ${row.impressions}`);
            console.log(`      clicks: ${row.clicks}`);
            console.log(`      cost: ${row.cost}`);
          });

          console.log('\n🔍 对比结论：');
          const firstRow = actualData[0];
          if (!/^\d{4}-\d{2}-\d{2}$/.test(firstRow.date)) {
            console.log('   ❌ date字段不是日期格式，说明列映射错误！');
          }
          if (firstRow.impressions === 0 && firstRow.clicks === 0 && firstRow.cost === 0) {
            console.log('   ❌ 所有数字字段都是0，说明列映射完全错误！');
          }
        } else {
          console.log('   （暂无数据）');
        }
      } catch (error) {
        console.error(`\n❌ 下载CSV失败: ${error.message}`);

        if (error.response) {
          console.log(`   HTTP状态码: ${error.response.status}`);
          console.log(`   可能原因: 表格未设置为"任何人可查看"，或者需要认证`);
        }
      }
    }

    console.log('\n\n' + '='.repeat(80));
    console.log('✅ 分析完成！');
    console.log('='.repeat(80));
    console.log('\n💡 下一步建议：');
    console.log('   1. 根据上面的分析结果，找到正确的列号');
    console.log('   2. 修改 server-v2.js 中的列映射代码');
    console.log('   3. 清空错误数据：DELETE FROM google_ads_data;');
    console.log('   4. 重新运行数据采集测试\n');
  } catch (error) {
    console.error('\n❌ 分析脚本执行失败:', error);
  } finally {
    db.close();
  }
}

// 运行分析
analyzeGoogleSheet();
