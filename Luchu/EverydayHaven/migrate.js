/**
 * 博客数据迁移脚本
 * 
 * 功能：将 js/data.js 拆分为：
 * - js/articles-index.js (索引)
 * - js/articles/*.json (单篇文章)
 * 
 * 使用：node migrate.js
 */

const fs = require('fs');
const path = require('path');

// ================== 配置区域 ==================
const CONFIG = {
  // 源文件路径
  sourceFile: 'js/data.js',
  
  // 输出路径
  outputIndexFile: 'js/articles-index.js',
  outputArticlesDir: 'js/articles',
  backupFile: 'js/data.js.backup',
  
  // 索引保留字段（列表页需要）
  indexFields: [
    'id', 'title', 'slug', 'category', 'categoryName',
    'date', 'image', 'excerpt', 'description', 'featured',
    'author', 'readTime'
  ],
  
  // 是否有产品模块
  hasProductModule: true
};
// ================== 配置结束 ==================

async function main() {
  console.log('🚀 开始迁移...\n');
  
  // 1. 检查源文件
  if (!fs.existsSync(CONFIG.sourceFile)) {
    console.error(`❌ 找不到 ${CONFIG.sourceFile}`);
    console.log('请确保在仓库根目录运行此脚本');
    process.exit(1);
  }
  
  // 2. 备份
  console.log('📦 备份原始文件...');
  fs.copyFileSync(CONFIG.sourceFile, CONFIG.backupFile);
  console.log(`   ✓ 已备份到 ${CONFIG.backupFile}\n`);
  
  // 3. 读取数据
  console.log('📖 读取源数据...');
  const sourceContent = fs.readFileSync(CONFIG.sourceFile, 'utf-8');
  const { articles, categoryNames } = parseData(sourceContent);
  console.log(`   ✓ 找到 ${articles.length} 篇文章\n`);
  
  if (articles.length === 0) {
    console.error('❌ 未找到文章数据，请检查data.js格式');
    process.exit(1);
  }
  
  // 4. 创建目录
  console.log('📁 创建输出目录...');
  if (!fs.existsSync(CONFIG.outputArticlesDir)) {
    fs.mkdirSync(CONFIG.outputArticlesDir, { recursive: true });
  }
  console.log(`   ✓ ${CONFIG.outputArticlesDir}\n`);
  
  // 5. 生成索引
  console.log('📝 生成索引文件...');
  const indexData = generateIndex(articles);
  const indexContent = `// 文章索引 - 生成于 ${new Date().toISOString()}
// 列表页使用此文件，详情页按需加载 articles/*.json

const articlesIndex = ${JSON.stringify(indexData, null, 2)};

// Category mapping
const categoryNames = ${JSON.stringify(categoryNames, null, 2)};

// Signal that articles-index.js has loaded
window.articlesDataLoaded = true;
`;
  fs.writeFileSync(CONFIG.outputIndexFile, indexContent, 'utf-8');
  console.log(`   ✓ ${CONFIG.outputIndexFile}\n`);
  
  // 6. 生成单篇文章
  console.log('📄 生成单篇文章文件...');
  let count = 0;
  for (const article of articles) {
    const filePath = path.join(CONFIG.outputArticlesDir, `${article.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(article, null, 2), 'utf-8');
    count++;
    const titlePreview = article.title.length > 30 ? article.title.substring(0, 30) + '...' : article.title;
    console.log(`   ✓ ${article.id}.json - ${titlePreview}`);
  }
  
  // 7. 统计
  console.log('\n📊 迁移统计:');
  console.log(`   - 原文件: ${(fs.statSync(CONFIG.backupFile).size / 1024).toFixed(2)} KB`);
  console.log(`   - 索引文件: ${(fs.statSync(CONFIG.outputIndexFile).size / 1024).toFixed(2)} KB`);
  console.log(`   - 文章数量: ${count} 篇`);
  
  // 8. 完成
  console.log('\n✅ 迁移完成！\n');
  console.log('📋 下一步操作:');
  console.log('─────────────────────────────────────');
  console.log('1. 更新HTML中的script引用:');
  console.log('   将 <script src="js/data.js"> ');
  console.log('   改为 <script src="js/articles-index.js">');
  console.log('');
  console.log('2. 更新JS中的文章加载逻辑');
  console.log('');
  console.log('3. 本地测试所有功能');
  console.log('');
  console.log('4. 推送到GitHub:');
  console.log('   git add .');
  console.log('   git commit -m "chore: 迁移文章存储格式"');
  console.log('   git push');
  console.log('─────────────────────────────────────\n');
}

// ================== 解析函数 ==================

function parseData(content) {
  let articles = [];
  let categoryNames = {};
  
  try {
    // 解析 articles 数组
    let articlesMatch = content.match(/(?:const|let|var)\s+articles\s*=\s*(\[[\s\S]*?\]);/);
    
    if (!articlesMatch) {
      // 尝试匹配到文件末尾的数组
      articlesMatch = content.match(/(?:const|let|var)\s+articles\s*=\s*(\[[\s\S]*\])\s*;?\s*(?:\/\/|const|let|var|$)/);
    }
    
    if (articlesMatch) {
      const parseFunc = new Function(`return ${articlesMatch[1]}`);
      articles = parseFunc();
    }
    
    // 解析 categoryNames 对象
    const categoryMatch = content.match(/(?:const|let|var)\s+categoryNames\s*=\s*(\{[\s\S]*?\});/);
    if (categoryMatch) {
      const parseCategoryFunc = new Function(`return ${categoryMatch[1]}`);
      categoryNames = parseCategoryFunc();
    }
    
    if (!Array.isArray(articles)) {
      throw new Error('解析结果不是数组');
    }
    
    return { articles, categoryNames };
  } catch (error) {
    console.error('解析错误:', error.message);
    console.log('\n💡 提示: 请检查data.js格式');
    process.exit(1);
  }
}

function generateIndex(articles) {
  return articles.map(article => {
    const entry = {};
    
    // 复制索引字段
    for (const field of CONFIG.indexFields) {
      if (article[field] !== undefined) {
        entry[field] = article[field];
      }
    }
    
    // 确保有摘要
    if (!entry.excerpt && !entry.description && article.content) {
      const text = article.content.replace(/<[^>]*>/g, '').trim();
      entry.excerpt = text.substring(0, 150) + '...';
    }
    
    // 标记产品模块
    entry.hasProducts = !!(article.products && article.products.length > 0);
    
    return entry;
  });
}

// 运行
main();



