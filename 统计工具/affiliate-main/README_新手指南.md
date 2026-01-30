# 新手开发指南 - 联盟营销数据平台

> 💡 **重要**: 这是一份为编程新手准备的循序渐进指南，帮你从零开始构建完整系统

---

## 🎯 学习路线图

```
阶段0: 验证核心逻辑 (1-2天)  ⭐ 你在这里
    ↓
阶段1: 搭建最小系统 (3-5天)
    ↓
阶段2: 添加数据库 (2-3天)
    ↓
阶段3: 实现用户系统 (3-5天)
    ↓
阶段4: 完善功能 (1-2周)
    ↓
阶段5: 部署上线 (2-3天)
```

---

## 阶段0: 验证核心逻辑 ⭐

### 目标
证明"从联盟平台API获取数据"这件事能做通，不涉及任何复杂技术。

### 你需要的工具
- Node.js (从 nodejs.org 下载安装)
- 一个代码编辑器 (推荐 VS Code)
- 你的LinkHaitao账号

### 第一步：安装依赖

```bash
# 在项目目录下打开命令行
cd C:\Users\Administrator\Desktop\cc05

# 安装必需的包
npm install axios
```

### 第二步：配置测试脚本

1. 打开 `test-linkhaitao.js`
2. 找到 `CONFIG` 对象
3. 填入你的真实账号信息：

```javascript
const CONFIG = {
  username: 'your_real_email@example.com',  // 改这里
  password: 'your_real_password',            // 改这里
  startDate: '2025-01-01',                   // 改成你想查询的日期
  endDate: '2025-01-15',
};
```

### 第三步：运行测试

```bash
npm run test:lh
```

### 期望结果

如果成功，你会看到：

```
🚀 LinkHaitao 数据采集测试脚本
==================================================
🔐 开始登录LinkHaitao...
✅ 登录成功！Token: abc123...

📊 开始获取佣金数据 (2025-01-01 ~ 2025-01-15)...
✅ 获取成功！共 25 条商家数据

📦 数据示例：
[1] 商家ID: amazon
    点击数: 1234
    订单数: 56
    佣金: $789.50

💰 汇总数据：
    总点击: 5678
    总订单: 234
    总佣金: $3456.78

✅ 测试成功！数据采集功能正常工作
🎉 你可以继续下一步了！
```

### 常见问题

**Q: 报错 "login failed"**
A: 检查用户名密码是否正确，或者可能是验证码问题（脚本中简化了验证码处理）

**Q: 报错 "network error"**
A: 检查网络连接，确保能访问 linkhaitao.com

**Q: 数据为空**
A: 检查日期范围内是否真的有数据

---

## 阶段1: 搭建最小系统 (当阶段0成功后)

### 目标
创建一个简单的网页，点击按钮就能触发数据采集，在页面上显示结果。

### 技术栈（最简单的）
- **不用React/Vue** ❌ 太复杂
- **用纯HTML + Express** ✅ 简单直接

### 文件结构
```
cc05/
├── server.js           # 后端服务器
├── public/
│   └── index.html      # 前端页面
└── scrapers/
    └── linkhaitao.js   # 数据采集器(从测试脚本复制)
```

### 代码示例

#### server.js (后端)
```javascript
const express = require('express');
const { fetchData } = require('./scrapers/linkhaitao');

const app = express();

// 提供静态页面
app.use(express.static('public'));

// API：触发数据采集
app.get('/api/fetch', async (req, res) => {
  try {
    const data = await fetchData();
    res.json({ success: true, data });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.listen(3000, () => {
  console.log('✅ 服务器运行在 http://localhost:3000');
});
```

#### public/index.html (前端)
```html
<!DOCTYPE html>
<html>
<head>
  <title>数据采集测试</title>
  <style>
    body { font-family: Arial; max-width: 800px; margin: 50px auto; }
    button { padding: 10px 20px; font-size: 16px; }
    #result { margin-top: 20px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1>LinkHaitao 数据采集</h1>
  <button onclick="fetchData()">点击采集数据</button>
  <div id="result"></div>

  <script>
    async function fetchData() {
      document.getElementById('result').textContent = '加载中...';

      const response = await fetch('/api/fetch');
      const result = await response.json();

      document.getElementById('result').textContent =
        JSON.stringify(result, null, 2);
    }
  </script>
</body>
</html>
```

### 运行方式
```bash
node server.js
# 打开浏览器访问 http://localhost:3000
```

---

## 阶段2: 添加数据库 (当阶段1成功后)

### 目标
把采集到的数据存到数据库，下次查看时不用重新采集。

### 最简单的数据库选择
- **SQLite** ✅ 无需安装，一个文件搞定
- **不用PostgreSQL** ❌ 对新手太复杂

### 安装
```bash
npm install better-sqlite3
```

### 创建数据库表
```javascript
// db.js
const Database = require('better-sqlite3');
const db = new Database('data.db');

// 创建表
db.exec(`
  CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    merchant_id TEXT,
    clicks INTEGER,
    commission REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 插入数据
function saveData(data) {
  const insert = db.prepare(`
    INSERT INTO metrics (date, merchant_id, clicks, commission)
    VALUES (?, ?, ?, ?)
  `);

  for (const item of data) {
    insert.run(item.date, item.merchantId, item.clicks, item.commission);
  }
}

// 查询数据
function getData() {
  return db.prepare('SELECT * FROM metrics ORDER BY date DESC').all();
}

module.exports = { saveData, getData };
```

---

## 阶段3: 实现用户系统 (当阶段2成功后)

### 目标
多个人可以注册账号，各自管理自己的联盟账号和数据。

### 最简单的认证方式
- **Passport.js** ✅ 简单够用
- **不用NextAuth** ❌ 需要理解Next.js

### 用户表
```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  password TEXT,  -- 记得用 bcrypt 加密
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  platform TEXT,
  username_encrypted TEXT,
  password_encrypted TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
```

---

## 阶段4: 完善功能

当前面都做完了，再考虑：
- 定时任务 (node-cron)
- 数据报表 (Chart.js)
- 导出Excel (xlsx)
- 邮件通知 (nodemailer)

---

## 阶段5: 部署上线

### 最简单的部署方式
1. **前期**: 本地运行，用ngrok暴露到公网
2. **后期**: 买个便宜的VPS (Vultr $5/月)

---

## 🎯 关键建议

### ✅ 做什么
1. **一步一步来** - 每完成一个阶段再进入下一个
2. **先做最简单的** - 别上来就想做完美的架构
3. **实际测试** - 每写10行代码就运行一次
4. **保存进度** - 用Git提交每个阶段的代码

### ❌ 不要做什么
1. **不要纠结技术选型** - 先用最简单的能跑起来
2. **不要过早优化** - 先实现功能，再考虑性能
3. **不要同时学太多** - 一次只学一个新技术
4. **不要跳过测试** - 每个阶段都要确保能跑

---

## 📚 推荐学习资源

### 必学基础 (如果你还不会)
1. **JavaScript基础** - MDN Web Docs
2. **Node.js入门** - Node.js官方教程
3. **Express框架** - Express官方文档

### 进阶学习 (阶段3之后)
1. **数据库基础** - SQLite Tutorial
2. **用户认证** - Passport.js文档
3. **前端框架** - React或Vue官方教程

---

## 🆘 遇到问题怎么办？

### 调试步骤
1. **读错误信息** - 90%的问题错误信息已经告诉你了
2. **用console.log** - 在关键位置打印变量
3. **Google搜索** - 复制完整错误信息搜索
4. **问AI** - 把错误信息和相关代码发给我

### 常见错误
- **端口被占用**: 换个端口或关闭占用的程序
- **模块找不到**: 运行 `npm install`
- **CORS错误**: 加上 `app.use(cors())`
- **数据库锁定**: 关闭其他访问数据库的程序

---

## 🎉 下一步

### 现在立即做
1. 安装Node.js (如果还没装)
2. 运行 `npm install axios`
3. 修改 `test-linkhaitao.js` 中的配置
4. 运行 `npm run test:lh`

**如果看到"测试成功"，立即告诉我，我会给你下一阶段的代码！**

---

## 💡 心态建议

> **编程是一门手艺活，不是理论课**
>
> - 看100遍视频 < 自己写1遍代码
> - 理解所有原理 < 先跑起来再说
> - 追求完美架构 < 能用就是好架构
>
> **你不需要成为专家才能开始，但你需要开始才能成为专家**

---

**现在，打开你的命令行，开始第一步吧！加油！** 🚀
