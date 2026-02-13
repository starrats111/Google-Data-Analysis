/**
 * Quiblo 数据迁移脚本
 * 
 * 特殊处理: data.js在根目录，数组名为blogPosts
 * 
 * 使用：node migrate.js
 */

const fs = require('fs');
const path = require('path');

const CONFIG = {
  sourceFile: 'data.js',  // Quiblo的data.js在根目录
  outputIndexFile: 'js/articles-index.js',
  outputArticlesDir: 'js/articles',
  backupFile: 'data.js.backup',
  indexFields: [
    'id', 'title', 'slug', 'category', 'categoryName',
    'date', 'image', 'excerpt', 'description', 'featured',
    'author', 'readTime'
  ]
};

async function main() {
  console.log('🚀 开始迁移 Quiblo...\n');
  
  if (!fs.existsSync(CONFIG.sourceFile)) {
    console.error(`❌ 找不到 ${CONFIG.sourceFile}`);
    process.exit(1);
  }
  
  // 备份
  console.log('📦 备份原始文件...');
  fs.copyFileSync(CONFIG.sourceFile, CONFIG.backupFile);
  console.log(`   ✓ 已备份到 ${CONFIG.backupFile}\n`);
  
  // 读取数据
  console.log('📖 读取源数据...');
  const sourceContent = fs.readFileSync(CONFIG.sourceFile, 'utf-8');
  const articles = parseArticles(sourceContent);
  console.log(`   ✓ 找到 ${articles.length} 篇文章\n`);
  
  if (articles.length === 0) {
    console.error('❌ 未找到文章数据');
    process.exit(1);
  }
  
  // 创建目录
  console.log('📁 创建输出目录...');
  if (!fs.existsSync('js')) {
    fs.mkdirSync('js', { recursive: true });
  }
  if (!fs.existsSync(CONFIG.outputArticlesDir)) {
    fs.mkdirSync(CONFIG.outputArticlesDir, { recursive: true });
  }
  console.log(`   ✓ ${CONFIG.outputArticlesDir}\n`);
  
  // 生成索引
  console.log('📝 生成索引文件...');
  const indexData = generateIndex(articles);
  const indexContent = `// 文章索引 - 生成于 ${new Date().toISOString()}
// 列表页使用此文件，详情页按需加载 articles/*.json

const articlesIndex = ${JSON.stringify(indexData, null, 2)};

// 兼容旧代码
const blogPosts = articlesIndex;
`;
  fs.writeFileSync(CONFIG.outputIndexFile, indexContent, 'utf-8');
  console.log(`   ✓ ${CONFIG.outputIndexFile}\n`);
  
  // 生成单篇文章
  console.log('📄 生成单篇文章文件...');
  for (const article of articles) {
    const filePath = path.join(CONFIG.outputArticlesDir, `${article.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(article, null, 2), 'utf-8');
    console.log(`   ✓ ${article.id}.json`);
  }
  
  // 统计
  console.log('\n📊 迁移统计:');
  console.log(`   - 原文件: ${(fs.statSync(CONFIG.backupFile).size / 1024).toFixed(2)} KB`);
  console.log(`   - 索引文件: ${(fs.statSync(CONFIG.outputIndexFile).size / 1024).toFixed(2)} KB`);
  console.log(`   - 文章数量: ${articles.length} 篇`);
  
  console.log('\n✅ 迁移完成！\n');
}

function parseArticles(content) {
  try {
    // Quiblo使用blogPosts
    let match = content.match(/(?:const|let|var)\s+blogPosts\s*=\s*(\[[\s\S]*\])\s*;?\s*$/);
    if (!match) {
      match = content.match(/(?:const|let|var)\s+blogPosts\s*=\s*(\[[\s\S]*?\]);/);
    }
    if (!match) {
      match = content.match(/(?:const|let|var)\s+(?:articles|posts|data|blogPosts)\s*=\s*(\[[\s\S]*\])/);
    }
    
    if (!match) {
      throw new Error('找不到文章数组');
    }
    
    const parseFunc = new Function(`return ${match[1]}`);
    return parseFunc();
  } catch (error) {
    console.error('解析错误:', error.message);
    process.exit(1);
  }
}

function generateIndex(articles) {
  return articles.map(article => {
    const entry = {};
    for (const field of CONFIG.indexFields) {
      if (article[field] !== undefined) {
        entry[field] = article[field];
      }
    }
    if (!entry.excerpt && !entry.description && article.content) {
      const text = article.content.replace(/<[^>]*>/g, '').trim();
      entry.excerpt = text.substring(0, 150) + '...';
    }
    entry.hasProducts = !!(article.products && article.products.length > 0);
    return entry;
  });
}

main();

