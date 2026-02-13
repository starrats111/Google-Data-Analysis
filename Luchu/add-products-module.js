/**
 * 批量添加产品模块脚本
 * 
 * 功能：为所有网站添加产品展示模块
 * 运行：node add-products-module.js
 * 
 * 创建日期：2026-02-13
 */

const fs = require('fs');
const path = require('path');

// ==================== 配置 ====================
const BASE_DIR = __dirname;

const WEBSITES = [
  { name: 'AlluraHub', dir: 'AlluraHub', owner: 'wj06' },
  { name: 'BloomRoots', dir: 'BloomRoots', owner: 'wj09' },
  { name: 'EverydayHaven', dir: 'EverydayHaven', owner: 'wj01' },
  { name: 'Kivanta', dir: 'Kivanta', owner: 'wj03' },
  { name: 'Quiblo', dir: 'Quiblo', owner: 'wj02' },
  { name: 'VitaHaven', dir: 'VitaHaven', owner: 'wj07' },
  { name: 'VitaSphere', dir: 'VitaSphere', owner: 'wj10' },
  { name: 'Zontri', dir: 'Zontri', owner: 'wj05', hasProducts: true }, // 已有产品模块
  { name: 'Novanest', dir: 'novanest', owner: 'wj04' }, // 小写目录名
];

// ==================== 产品模块HTML ====================
const PRODUCTS_HTML = `
  <!-- 产品推荐模块 - 由脚本自动添加 -->
  <section id="products-section" class="products-section" style="display: none;">
    <div class="container">
      <h3 class="products-title">Recommended Products</h3>
      <div id="products-container" class="products-grid">
        <!-- 产品卡片将由JS动态插入 -->
      </div>
    </div>
  </section>
  <!-- 产品模块结束 -->`;

// ==================== 产品模块CSS ====================
const PRODUCTS_CSS = `

/* ==================== 产品推荐模块 ==================== */
/* 由脚本自动添加 - 2026-02-13 */

.products-section {
  margin-top: 50px;
  padding: 40px 0;
  background: #f8f9fa;
  border-radius: 12px;
}

.products-title {
  font-size: 24px;
  font-weight: 600;
  margin-bottom: 24px;
  color: #333;
  text-align: center;
}

.products-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 24px;
  padding: 0 20px;
}

.product-card {
  background: #fff;
  border: 1px solid #e9ecef;
  border-radius: 12px;
  overflow: hidden;
  transition: box-shadow 0.25s ease, transform 0.25s ease;
}

.product-card:hover {
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  transform: translateY(-4px);
}

.product-card img {
  width: 100%;
  height: 200px;
  object-fit: cover;
  border-bottom: 1px solid #e9ecef;
}

.product-card-body {
  padding: 20px;
}

.product-card h4 {
  font-size: 17px;
  font-weight: 600;
  margin: 0 0 10px 0;
  color: #333;
  line-height: 1.4;
}

.product-card p {
  font-size: 14px;
  color: #666;
  margin: 0 0 14px 0;
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.product-card .price {
  display: block;
  font-size: 20px;
  font-weight: 700;
  color: #e53935;
  margin-bottom: 14px;
}

.product-card .buy-btn {
  display: inline-block;
  padding: 10px 20px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: #fff;
  text-decoration: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  transition: opacity 0.2s, transform 0.2s;
}

.product-card .buy-btn:hover {
  opacity: 0.9;
  transform: scale(1.02);
}

/* 产品模块响应式 */
@media (max-width: 768px) {
  .products-section {
    margin-top: 30px;
    padding: 30px 0;
  }
  
  .products-grid {
    grid-template-columns: 1fr;
    padding: 0 15px;
  }
  
  .product-card img {
    height: 180px;
  }
}

/* ==================== 产品模块结束 ==================== */
`;

// ==================== 产品模块JS ====================
const PRODUCTS_JS = `

// ==================== 产品模块渲染 ====================
// 由脚本自动添加 - 2026-02-13

/**
 * 渲染产品推荐模块
 * @param {Array} products - 产品数组
 */
function renderProducts(products) {
  const section = document.getElementById('products-section');
  const container = document.getElementById('products-container');
  
  // 检查元素是否存在
  if (!section || !container) {
    console.log('Products section not found in this page');
    return;
  }
  
  // 如果没有产品数据，隐藏模块
  if (!products || !Array.isArray(products) || products.length === 0) {
    section.style.display = 'none';
    return;
  }
  
  // 显示模块并渲染产品
  section.style.display = 'block';
  
  container.innerHTML = products.map(function(product) {
    var imageHtml = product.image 
      ? '<img src="' + product.image + '" alt="' + (product.name || 'Product') + '" loading="lazy" onerror="this.style.display=\\'none\\'">'
      : '';
    
    var descHtml = product.description 
      ? '<p>' + product.description + '</p>' 
      : '';
    
    var priceHtml = product.price 
      ? '<span class="price">' + product.price + '</span>' 
      : '';
    
    var linkHtml = product.link 
      ? '<a href="' + product.link + '" class="buy-btn" target="_blank" rel="noopener nofollow">View Details</a>'
      : '';
    
    return '<div class="product-card">' +
      imageHtml +
      '<div class="product-card-body">' +
        '<h4>' + (product.name || 'Product') + '</h4>' +
        descHtml +
        priceHtml +
        linkHtml +
      '</div>' +
    '</div>';
  }).join('');
}

// ==================== 产品模块结束 ====================
`;

// ==================== 主函数 ====================
async function main() {
  console.log('🚀 开始为所有网站添加产品模块...\n');
  
  const results = {
    success: [],
    skipped: [],
    failed: []
  };
  
  for (const site of WEBSITES) {
    console.log(`\n📦 处理: ${site.name} (${site.owner})`);
    console.log('─'.repeat(40));
    
    const siteDir = path.join(BASE_DIR, site.dir);
    
    // 检查目录是否存在
    if (!fs.existsSync(siteDir)) {
      console.log(`   ❌ 目录不存在: ${siteDir}`);
      results.failed.push({ site: site.name, reason: '目录不存在' });
      continue;
    }
    
    // 如果已有产品模块，跳过
    if (site.hasProducts) {
      console.log(`   ⏭️ 已有产品模块，跳过`);
      results.skipped.push({ site: site.name, reason: '已有产品模块' });
      continue;
    }
    
    try {
      // 1. 处理 HTML 文件
      const htmlResult = processHtml(siteDir, site.name);
      
      // 2. 处理 CSS 文件
      const cssResult = processCss(siteDir, site.name);
      
      // 3. 处理 JS 文件
      const jsResult = processJs(siteDir, site.name);
      
      if (htmlResult && cssResult && jsResult) {
        results.success.push(site.name);
        console.log(`   ✅ 完成`);
      } else {
        results.failed.push({ site: site.name, reason: '部分文件处理失败' });
      }
      
    } catch (error) {
      console.log(`   ❌ 错误: ${error.message}`);
      results.failed.push({ site: site.name, reason: error.message });
    }
  }
  
  // 打印统计
  console.log('\n');
  console.log('═'.repeat(50));
  console.log('📊 处理结果统计');
  console.log('═'.repeat(50));
  console.log(`✅ 成功: ${results.success.length} 个`);
  if (results.success.length > 0) {
    console.log(`   ${results.success.join(', ')}`);
  }
  console.log(`⏭️ 跳过: ${results.skipped.length} 个`);
  if (results.skipped.length > 0) {
    results.skipped.forEach(s => console.log(`   ${s.site}: ${s.reason}`));
  }
  console.log(`❌ 失败: ${results.failed.length} 个`);
  if (results.failed.length > 0) {
    results.failed.forEach(s => console.log(`   ${s.site}: ${s.reason}`));
  }
  
  console.log('\n');
  console.log('📋 下一步操作:');
  console.log('─'.repeat(50));
  console.log('1. 检查各网站的修改是否正确');
  console.log('2. 本地预览测试');
  console.log('3. 推送到 GitHub:');
  console.log('');
  console.log('   cd 各网站目录');
  console.log('   git add .');
  console.log('   git commit -m "feat: 添加产品推荐模块"');
  console.log('   git push');
  console.log('');
}

// ==================== HTML处理 ====================
function processHtml(siteDir, siteName) {
  // 可能的HTML文件名
  const possibleFiles = ['article.html', 'post.html', 'single.html', 'blog-post.html'];
  let htmlFile = null;
  
  for (const file of possibleFiles) {
    const filePath = path.join(siteDir, file);
    if (fs.existsSync(filePath)) {
      htmlFile = filePath;
      break;
    }
  }
  
  if (!htmlFile) {
    console.log(`   ⚠️ 未找到文章详情页HTML文件`);
    // 列出目录中的HTML文件
    const htmlFiles = fs.readdirSync(siteDir).filter(f => f.endsWith('.html'));
    console.log(`   📁 目录中的HTML文件: ${htmlFiles.join(', ') || '无'}`);
    return false;
  }
  
  console.log(`   📄 HTML: ${path.basename(htmlFile)}`);
  
  let content = fs.readFileSync(htmlFile, 'utf-8');
  
  // 检查是否已添加
  if (content.includes('products-section') || content.includes('products-container')) {
    console.log(`      已包含产品模块，跳过`);
    return true;
  }
  
  // 查找插入位置：</main> 或 </article> 或 </body> 之前
  let insertPoint = null;
  let insertBefore = null;
  
  const markers = ['</main>', '</article>', '</body>'];
  for (const marker of markers) {
    const index = content.lastIndexOf(marker);
    if (index !== -1) {
      insertPoint = index;
      insertBefore = marker;
      break;
    }
  }
  
  if (insertPoint === null) {
    console.log(`      ⚠️ 无法找到插入位置`);
    return false;
  }
  
  // 插入产品模块HTML
  const newContent = content.slice(0, insertPoint) + PRODUCTS_HTML + '\n  ' + content.slice(insertPoint);
  
  // 备份并写入
  fs.writeFileSync(htmlFile + '.backup', content, 'utf-8');
  fs.writeFileSync(htmlFile, newContent, 'utf-8');
  console.log(`      ✓ 已添加产品模块 (在 ${insertBefore} 之前)`);
  
  return true;
}

// ==================== CSS处理 ====================
function processCss(siteDir, siteName) {
  // 可能的CSS文件路径
  const possiblePaths = [
    path.join(siteDir, 'css', 'style.css'),
    path.join(siteDir, 'css', 'styles.css'),
    path.join(siteDir, 'css', 'main.css'),
    path.join(siteDir, 'style.css'),
    path.join(siteDir, 'styles.css'),
    path.join(siteDir, 'assets', 'css', 'style.css'),
  ];
  
  let cssFile = null;
  for (const filePath of possiblePaths) {
    if (fs.existsSync(filePath)) {
      cssFile = filePath;
      break;
    }
  }
  
  if (!cssFile) {
    console.log(`   ⚠️ 未找到CSS文件，创建新文件`);
    // 创建css目录
    const cssDir = path.join(siteDir, 'css');
    if (!fs.existsSync(cssDir)) {
      fs.mkdirSync(cssDir, { recursive: true });
    }
    cssFile = path.join(cssDir, 'products.css');
    fs.writeFileSync(cssFile, PRODUCTS_CSS.trim(), 'utf-8');
    console.log(`   📝 CSS: 创建 css/products.css`);
    return true;
  }
  
  console.log(`   🎨 CSS: ${path.relative(siteDir, cssFile)}`);
  
  let content = fs.readFileSync(cssFile, 'utf-8');
  
  // 检查是否已添加
  if (content.includes('.products-section') || content.includes('.product-card')) {
    console.log(`      已包含产品样式，跳过`);
    return true;
  }
  
  // 追加CSS
  fs.writeFileSync(cssFile + '.backup', content, 'utf-8');
  fs.writeFileSync(cssFile, content + PRODUCTS_CSS, 'utf-8');
  console.log(`      ✓ 已追加产品样式`);
  
  return true;
}

// ==================== JS处理 ====================
function processJs(siteDir, siteName) {
  // 可能的JS文件路径
  const possiblePaths = [
    path.join(siteDir, 'js', 'main.js'),
    path.join(siteDir, 'js', 'app.js'),
    path.join(siteDir, 'js', 'script.js'),
    path.join(siteDir, 'js', 'scripts.js'),
    path.join(siteDir, 'main.js'),
    path.join(siteDir, 'script.js'),
    path.join(siteDir, 'assets', 'js', 'main.js'),
  ];
  
  let jsFile = null;
  for (const filePath of possiblePaths) {
    if (fs.existsSync(filePath)) {
      jsFile = filePath;
      break;
    }
  }
  
  if (!jsFile) {
    console.log(`   ⚠️ 未找到JS文件，创建新文件`);
    // 创建js目录
    const jsDir = path.join(siteDir, 'js');
    if (!fs.existsSync(jsDir)) {
      fs.mkdirSync(jsDir, { recursive: true });
    }
    jsFile = path.join(jsDir, 'products.js');
    fs.writeFileSync(jsFile, PRODUCTS_JS.trim(), 'utf-8');
    console.log(`   📝 JS: 创建 js/products.js`);
    return true;
  }
  
  console.log(`   📜 JS: ${path.relative(siteDir, jsFile)}`);
  
  let content = fs.readFileSync(jsFile, 'utf-8');
  
  // 检查是否已添加
  if (content.includes('renderProducts') && content.includes('products-section')) {
    console.log(`      已包含产品渲染函数，跳过`);
    return true;
  }
  
  // 追加JS
  fs.writeFileSync(jsFile + '.backup', content, 'utf-8');
  fs.writeFileSync(jsFile, content + PRODUCTS_JS, 'utf-8');
  console.log(`      ✓ 已追加产品渲染函数`);
  
  return true;
}

// ==================== 运行 ====================
main().catch(console.error);



