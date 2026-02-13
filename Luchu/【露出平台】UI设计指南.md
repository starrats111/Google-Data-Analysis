# 🎨 露出平台 UI 设计指南

> **风格定位**: 浅色、柔和、专业  
> **设计理念**: 简洁高效，减少视觉负担

---

## 一、色彩系统

### 1.1 主色调

```css
:root {
  /* 主色 - 柔和蓝 */
  --primary-50: #f0f7ff;
  --primary-100: #e0efff;
  --primary-200: #baddff;
  --primary-300: #7cc2ff;
  --primary-400: #36a3ff;
  --primary-500: #0284c7;   /* 主色 */
  --primary-600: #0369a1;
  --primary-700: #075985;
  
  /* 背景色 - 暖白/米白 */
  --bg-primary: #fafaf9;    /* 主背景 */
  --bg-secondary: #f5f5f4;  /* 次级背景 */
  --bg-card: #ffffff;       /* 卡片背景 */
  
  /* 文字色 */
  --text-primary: #1c1917;   /* 主文字 */
  --text-secondary: #57534e; /* 次级文字 */
  --text-muted: #a8a29e;     /* 辅助文字 */
  
  /* 边框色 */
  --border-light: #e7e5e4;
  --border-medium: #d6d3d1;
  
  /* 状态色 */
  --success: #22c55e;
  --success-light: #dcfce7;
  --warning: #f59e0b;
  --warning-light: #fef3c7;
  --error: #ef4444;
  --error-light: #fee2e2;
  --info: #3b82f6;
  --info-light: #dbeafe;
}
```

### 1.2 色彩应用

| 场景 | 使用颜色 |
|------|----------|
| 页面背景 | `--bg-primary` (#fafaf9) |
| 卡片/面板 | `--bg-card` (#ffffff) |
| 侧边栏 | `--bg-secondary` (#f5f5f4) |
| 主按钮 | `--primary-500` (#0284c7) |
| 主按钮悬停 | `--primary-600` (#0369a1) |
| 次级按钮 | `--bg-secondary` + `--border-medium` |
| 链接 | `--primary-500` |
| 正文文字 | `--text-primary` |
| 说明文字 | `--text-secondary` |
| 占位符 | `--text-muted` |

---

## 二、排版系统

### 2.1 字体

```css
:root {
  /* 中文优先字体栈 */
  --font-sans: "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
  
  /* 英文数字字体（可选） */
  --font-mono: "SF Mono", "Consolas", "Monaco", monospace;
}
```

### 2.2 字号

| 用途 | 字号 | 字重 |
|------|------|------|
| 大标题 H1 | 28px | 600 |
| 页面标题 H2 | 22px | 600 |
| 区块标题 H3 | 18px | 500 |
| 小标题 H4 | 16px | 500 |
| 正文 | 14px | 400 |
| 辅助文字 | 13px | 400 |
| 小字/标签 | 12px | 400 |

### 2.3 行高

- 标题: 1.3
- 正文: 1.6
- 紧凑文字: 1.4

---

## 三、间距系统

### 3.1 基础间距

```css
:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;
}
```

### 3.2 应用场景

| 场景 | 间距 |
|------|------|
| 元素内边距（小） | 8px |
| 元素内边距（中） | 12-16px |
| 元素内边距（大） | 20-24px |
| 卡片内边距 | 20-24px |
| 模块间距 | 24-32px |
| 页面边距 | 24-32px |

---

## 四、圆角系统

```css
:root {
  --radius-sm: 4px;    /* 小按钮、标签 */
  --radius-md: 8px;    /* 输入框、按钮 */
  --radius-lg: 12px;   /* 卡片、弹窗 */
  --radius-xl: 16px;   /* 大卡片 */
  --radius-full: 9999px; /* 圆形/胶囊 */
}
```

---

## 五、阴影系统

```css
:root {
  /* 柔和阴影 - 符合浅色柔和风格 */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.04);
  --shadow-md: 0 2px 8px rgba(0, 0, 0, 0.06);
  --shadow-lg: 0 4px 16px rgba(0, 0, 0, 0.08);
  --shadow-xl: 0 8px 24px rgba(0, 0, 0, 0.1);
}
```

| 场景 | 阴影 |
|------|------|
| 卡片默认 | `--shadow-sm` |
| 卡片悬停 | `--shadow-md` |
| 下拉菜单 | `--shadow-lg` |
| 弹窗/模态框 | `--shadow-xl` |

---

## 六、组件样式

### 6.1 按钮

```css
/* 主按钮 */
.btn-primary {
  background: var(--primary-500);
  color: white;
  padding: 10px 20px;
  border-radius: var(--radius-md);
  font-weight: 500;
  transition: all 0.2s;
}
.btn-primary:hover {
  background: var(--primary-600);
}

/* 次级按钮 */
.btn-secondary {
  background: white;
  color: var(--text-primary);
  border: 1px solid var(--border-medium);
  padding: 10px 20px;
  border-radius: var(--radius-md);
}
.btn-secondary:hover {
  background: var(--bg-secondary);
}

/* 文字按钮 */
.btn-text {
  background: transparent;
  color: var(--primary-500);
  padding: 10px 16px;
}
.btn-text:hover {
  background: var(--primary-50);
}
```

### 6.2 输入框

```css
.input {
  background: white;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  padding: 10px 14px;
  font-size: 14px;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.input:focus {
  border-color: var(--primary-400);
  box-shadow: 0 0 0 3px var(--primary-100);
  outline: none;
}
.input::placeholder {
  color: var(--text-muted);
}
```

### 6.3 卡片

```css
.card {
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  padding: 20px;
  box-shadow: var(--shadow-sm);
}
.card:hover {
  box-shadow: var(--shadow-md);
}
```

### 6.4 状态标签

```css
/* 草稿 */
.tag-draft {
  background: var(--bg-secondary);
  color: var(--text-secondary);
}

/* 待审核 */
.tag-pending {
  background: var(--warning-light);
  color: #b45309;
}

/* 已通过 */
.tag-approved {
  background: var(--success-light);
  color: #15803d;
}

/* 已驳回 */
.tag-rejected {
  background: var(--error-light);
  color: #dc2626;
}

/* 已发布 */
.tag-published {
  background: var(--info-light);
  color: #1d4ed8;
}
```

---

## 七、布局规范

### 7.1 页面结构

```
┌─────────────────────────────────────────────────────────┐
│  顶栏 (60px高度, 白色背景, 底部细线分隔)                │
├──────────┬──────────────────────────────────────────────┤
│          │                                              │
│  侧边栏  │              主内容区                        │
│  (220px) │              (padding: 24px)                 │
│  浅灰背景│              暖白背景                        │
│          │                                              │
│          │                                              │
│          │                                              │
└──────────┴──────────────────────────────────────────────┘
```

### 7.2 响应式断点

| 断点 | 宽度 | 调整 |
|------|------|------|
| 桌面 | ≥1280px | 标准布局 |
| 小桌面 | 1024-1279px | 侧边栏收窄至180px |
| 平板 | 768-1023px | 侧边栏可收起 |
| 手机 | <768px | 底部导航（可选支持） |

---

## 八、图标规范

### 8.1 图标库

推荐使用 **Lucide React**（轻量、风格统一）

```bash
npm install lucide-react
```

### 8.2 图标尺寸

| 场景 | 尺寸 |
|------|------|
| 导航图标 | 20px |
| 按钮内图标 | 16px |
| 表格操作 | 16px |
| 空状态 | 48-64px |

### 8.3 常用图标

| 功能 | 图标名 |
|------|--------|
| 创建 | `Plus`, `PenLine` |
| 编辑 | `Pencil` |
| 删除 | `Trash2` |
| 预览 | `Eye` |
| 通过 | `Check`, `CheckCircle` |
| 驳回 | `X`, `XCircle` |
| 发布 | `Send`, `Upload` |
| 设置 | `Settings` |
| 用户 | `User`, `Users` |
| 网站 | `Globe` |
| 文章 | `FileText` |
| AI | `Sparkles`, `Wand2` |

---

## 九、动效规范

### 9.1 过渡时长

```css
:root {
  --transition-fast: 0.15s;
  --transition-normal: 0.2s;
  --transition-slow: 0.3s;
}
```

### 9.2 缓动函数

```css
:root {
  --ease-default: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-in: cubic-bezier(0.4, 0, 1, 1);
  --ease-out: cubic-bezier(0, 0, 0.2, 1);
}
```

### 9.3 应用场景

| 场景 | 时长 | 效果 |
|------|------|------|
| 按钮悬停 | fast | 背景色变化 |
| 输入框聚焦 | normal | 边框+阴影 |
| 卡片悬停 | normal | 阴影加深 |
| 页面切换 | slow | 淡入淡出 |
| 弹窗出现 | normal | 缩放+淡入 |

---

## 十、设计示例

### 10.1 创建内容页面配色

```
背景色: #fafaf9 (暖白)
卡片: #ffffff (纯白) + 1px #e7e5e4 边框
输入框: 白色背景 + 浅灰边框
AI生成按钮: #0284c7 (柔和蓝)
标签: 柔和的状态色背景
```

### 10.2 整体视觉感受

- ✅ 干净整洁，不刺眼
- ✅ 视觉层次清晰
- ✅ 操作区域明确
- ✅ 色彩柔和舒适
- ✅ 专业但不冰冷

---

**文档版本**: v1.0  
**创建日期**: 2026-02-13



