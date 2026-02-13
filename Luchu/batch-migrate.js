/**
 * 批量数据迁移脚本
 * 处理: AlluraHub, VitaHaven, BloomRoots, VitaSphere
 * 
 * 运行: node batch-migrate.js
 */

const fs = require('fs');
const path = require('path');

// 网站配置
const SITES = [
  {
    name: 'AlluraHub',
    dir: 'AlluraHub',
    sourceFile: 'js/data.js',
    arrayName: 'articles',
    outputDir: 'js/articles',
    outputIndex: 'js/articles-index.js'
  },
  {
    name: 'VitaHaven',
    dir: 'VitaHaven',
    sourceFile: 'js/data.js',
    arrayName: 'articles',
    outputDir: 'js/articles',
    outputIndex: 'js/articles-index.js'
  },
  {
    name: 'BloomRoots',
    dir: 'BloomRoots',
    sourceFile: 'script.js',
    arrayName: 'articlesData',
    outputDir: 'js/articles',
    outputIndex: 'js/articles-index.js',
    keepOriginal: true  // BloomRoots的script.js还有其他代码，不能删除
  },
  {
    name: 'VitaSphere',
    dir: 'VitaSphere',
    sourceFile: 'js/data.js',
    arrayName: 'articles',
    outputDir: 'js/articles',
    outputIndex: 'js/articles-index.js'
  }
];

const INDEX_FIELDS = [
  'id', 'title', 'slug', 'category', 'categoryName',
  'date', 'image', 'excerpt', 'description', 'featured',
  'author', 'readTime', 'heroImage'
];

async function main() {
  console.log('🚀 批量迁移开始...\n');
  console.log('═'.repeat(60));
  
  const results = { success: [], failed: [] };
  
  for (const site of SITES) {
    console.log(`\n📦 处理: ${site.name}`);
    console.log('─'.repeat(40));
    
    const siteDir = path.join(__dirname, site.dir);
    const sourceFile = path.join(siteDir, site.sourceFile);
    
    if (!fs.existsSync(sourceFile)) {
      console.log(`   ❌ 找不到 ${site.sourceFile}`);
      results.failed.push({ site: site.name, reason: '源文件不存在' });
      continue;
    }
    
    try {
      // 1. 读取源文件
      console.log(`   📖 读取 ${site.sourceFile}...`);
      const sourceContent = fs.readFileSync(sourceFile, 'utf-8');
      const articles = parseArticles(sourceContent, site.arrayName);
      console.log(`   ✓ 找到 ${articles.length} 篇文章`);
      
      if (articles.length === 0) {
        console.log(`   ⚠️ 没有文章，跳过`);
        results.failed.push({ site: site.name, reason: '无文章数据' });
        continue;
      }
      
      // 2. 备份
      const backupFile = sourceFile + '.backup';
      if (!fs.existsSync(backupFile)) {
        fs.copyFileSync(sourceFile, backupFile);
        console.log(`   📦 已备份到 ${path.basename(backupFile)}`);
      }
      
      // 3. 创建目录
      const articlesDir = path.join(siteDir, site.outputDir);
      if (!fs.existsSync(articlesDir)) {
        fs.mkdirSync(articlesDir, { recursive: true });
      }
      
      // 4. 生成索引
      const indexData = generateIndex(articles);
      const indexContent = `// 文章索引 - 生成于 ${new Date().toISOString()}
// 列表页使用此文件，详情页按需加载 articles/*.json

const articlesIndex = ${JSON.stringify(indexData, null, 2)};

// 兼容旧代码
const ${site.arrayName} = articlesIndex;
`;
      const indexFile = path.join(siteDir, site.outputIndex);
      
      // 确保js目录存在
      const jsDir = path.dirname(indexFile);
      if (!fs.existsSync(jsDir)) {
        fs.mkdirSync(jsDir, { recursive: true });
      }
      
      fs.writeFileSync(indexFile, indexContent, 'utf-8');
      console.log(`   📝 已生成 ${site.outputIndex}`);
      
      // 5. 生成单篇文章
      for (const article of articles) {
        const articleFile = path.join(articlesDir, `${article.id}.json`);
        fs.writeFileSync(articleFile, JSON.stringify(article, null, 2), 'utf-8');
      }
      console.log(`   📄 已生成 ${articles.length} 篇文章JSON`);
      
      // 6. 统计
      const originalSize = (fs.statSync(backupFile).size / 1024).toFixed(2);
      const indexSize = (fs.statSync(indexFile).size / 1024).toFixed(2);
      console.log(`   📊 原文件: ${originalSize}KB → 索引: ${indexSize}KB`);
      
      results.success.push(site.name);
      console.log(`   ✅ ${site.name} 迁移完成`);
      
    } catch (error) {
      console.log(`   ❌ 错误: ${error.message}`);
      results.failed.push({ site: site.name, reason: error.message });
    }
  }
  
  // 总结
  console.log('\n');
  console.log('═'.repeat(60));
  console.log('📊 迁移结果');
  console.log('═'.repeat(60));
  console.log(`✅ 成功: ${results.success.length} 个 - ${results.success.join(', ')}`);
  console.log(`❌ 失败: ${results.failed.length} 个`);
  results.failed.forEach(f => console.log(`   - ${f.site}: ${f.reason}`));
  console.log('\n');
}

function parseArticles(content, arrayName) {
  try {
    // 尝试匹配数组
    const patterns = [
      new RegExp(`(?:const|let|var)\\s+${arrayName}\\s*=\\s*(\\[[\\s\\S]*\\])\\s*;?\\s*$`),
      new RegExp(`(?:const|let|var)\\s+${arrayName}\\s*=\\s*(\\[[\\s\\S]*?\\]);`),
      new RegExp(`${arrayName}\\s*=\\s*(\\[[\\s\\S]*\\])`),
    ];
    
    let match = null;
    for (const pattern of patterns) {
      match = content.match(pattern);
      if (match) break;
    }
    
    if (!match) {
      throw new Error(`找不到 ${arrayName} 数组`);
    }
    
    const parseFunc = new Function(`return ${match[1]}`);
    const result = parseFunc();
    
    if (!Array.isArray(result)) {
      throw new Error('解析结果不是数组');
    }
    
    return result;
  } catch (error) {
    throw new Error(`解析失败: ${error.message}`);
  }
}

function generateIndex(articles) {
  return articles.map(article => {
    const entry = {};
    for (const field of INDEX_FIELDS) {
      if (article[field] !== undefined) {
        entry[field] = article[field];
      }
    }
    // 确保有摘要
    if (!entry.excerpt && !entry.description && article.content) {
      let text = '';
      if (Array.isArray(article.content)) {
        text = article.content.join(' ').replace(/<[^>]*>/g, '').trim();
      } else {
        text = String(article.content).replace(/<[^>]*>/g, '').trim();
      }
      entry.excerpt = text.substring(0, 150) + '...';
    }
    entry.hasProducts = !!(article.products && article.products.length > 0);
    return entry;
  });
}

main();

