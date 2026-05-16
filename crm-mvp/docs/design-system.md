# CRM 设计系统（Design System）

> 立项：D-009（2026-05-16）
> 目标：统一全站 33 个页面（user 18 / admin 11 / public 6）视觉与组件规范
> 维护人：设计研发 AI 助手

## 一、设计原则

1. **相信主题**：能用 `themeConfig` token 解决就不写 inline 样式；能用共享组件解决就不写裸 Antd 组件
2. **三档语义化**：padding / Modal 宽度 / 字号阶 全部分档，不写魔法数字
3. **图标语义化**：页头/按钮/Tag 用 Antd Icon；数据维度（国旗/⭐）保留 emoji
4. **可访问性**：所有图标必须配文本，颜色不作为唯一信息载体

---

## 二、设计 Token（`@/styles/themeConfig`）

### COLORS（11 颜色 + 6 灰色梯度 + 7 语义色）

```ts
import { COLORS } from "@/styles/themeConfig";

// 主色系
COLORS.primary       // #4DA6FF  天际蓝
COLORS.primaryDark   // #1A7FDB  hover 深蓝
COLORS.primaryLight  // #EBF5FF  选中淡蓝背景
COLORS.primaryBorder // #A8D4FF  按钮 border

// 背景
COLORS.bgPage     // #F0F5FA  页面底色
COLORS.bgCard     // #FFFFFF  卡片底色
COLORS.bgSidebar  // #FFFFFF  侧栏
COLORS.bgHover    // #F8F9FA  hover 灰底
COLORS.bgSubtle   // #F8FAFC  FilterBar/弱区分块底色

// 文本灰阶
COLORS.textPrimary    // #202124
COLORS.textSecondary  // #5F6368
COLORS.textTertiary   // #9AA0A6
COLORS.textDisabled   // #BFBFBF

// 边框/分隔灰
COLORS.border       // #E8EAED
COLORS.divider      // #F0F0F0
COLORS.grayLighter  // #FAFAFA
COLORS.grayLight    // #F5F5F5

// 语义色
COLORS.costRed       // #cf1322  花费
COLORS.successGreen  // #52c41a  成功
COLORS.incomeGreen   // #3f8600  收入
COLORS.warningOrange // #faad14  警告
COLORS.errorRed      // #ff4d4f  错误
COLORS.purpleAi      // #722ed1  AI 标识
```

### FONT_SIZE（8 档字号阶）

```ts
import { FONT_SIZE } from "@/styles/themeConfig";

FONT_SIZE.xs    // 11  脚注/角标
FONT_SIZE.sm    // 12  次级文本/Tooltip
FONT_SIZE.md    // 13  辅助说明
FONT_SIZE.base  // 14  正文（Antd 默认）
FONT_SIZE.lg    // 16  小标题
FONT_SIZE.xl    // 18  图标
FONT_SIZE.xxl   // 20  PageHeader 图标候选
FONT_SIZE.hero  // 24  StatCard 数值/PageHeader 图标
```

### SPACING（5 档间距）

```ts
import { SPACING } from "@/styles/themeConfig";

SPACING.xs  // 4
SPACING.sm  // 8
SPACING.md  // 16  默认间距
SPACING.lg  // 24
SPACING.xl  // 32
```

### MODAL_WIDTH（3 档语义化）

```ts
import { MODAL_WIDTH } from "@/styles/themeConfig";

MODAL_WIDTH.sm  // 480  表单 / 简单确认
MODAL_WIDTH.md  // 640  详情 / 中等表单
MODAL_WIDTH.lg  // 900  复杂表格 / 多 Tab

<Modal width={MODAL_WIDTH.md} />
```

---

## 三、共享组件

### `<AppPageHeader>` — 全站 app dashboard 统一页头

> **命名注意**：`PageHeader` 是公开营销页（about/contact/demo/privacy-policy/terms-of-service/根页）的绿色顶部导航栏（含 logo + 语言切换），**不要混用**。
> 登录后所有 user/* + admin/* 页面统一用 `AppPageHeader`。

```tsx
import AppPageHeader from "@/components/AppPageHeader";
import { ShopOutlined } from "@ant-design/icons";

<AppPageHeader
  icon={<ShopOutlined />}
  title="我的商家"
  subtitle="关注、领取、配置广告投放，所有商家围绕这一页运转"
  extra={<Button type="primary">导入</Button>}
/>
```

**规格**：icon 24px primary 色 · Title level=4 · subtitle 12px secondary · 16px 底部间距
**Tabs**：放在 AppPageHeader 兄弟节点，不并入 props

### `<SectionCard>` — 区块卡片

```tsx
import SectionCard from "@/components/SectionCard";

<SectionCard padding="md" title="基础信息">
  ...
</SectionCard>

// 密集列表用 sm
<SectionCard padding="sm" title="行项目">...</SectionCard>

// 主表格容器用 lg
<SectionCard padding="lg" title="商家列表">...</SectionCard>
```

**Padding 档位**：sm=`8 12` · md=`16` · lg=`20 24` · none=`0`

### `<StatCard>` — 统计卡片

```tsx
import StatCard from "@/components/StatCard";
import { DollarOutlined } from "@ant-design/icons";

<StatCard
  icon={<DollarOutlined />}
  label="今日花费"
  value="$1,234"
  valueColor={COLORS.costRed}
  trend="↑3.2%"
  hint="较昨日"
/>
```

### `<FilterBar>` — 筛选栏

```tsx
import FilterBar from "@/components/FilterBar";

<FilterBar
  extra={<Button icon={<ReloadOutlined />}>刷新</Button>}
>
  <Input placeholder="搜索..." style={{ width: 260 }} />
  <Select options={[...]} style={{ width: 160 }} />
</FilterBar>
```

### `<StatusTag>` — 语义化 Tag

```tsx
import StatusTag from "@/components/StatusTag";

<StatusTag status="success">已通过</StatusTag>
<StatusTag status="warning">异常</StatusTag>
<StatusTag status="danger">已禁用</StatusTag>
<StatusTag status="info">处理中</StatusTag>
<StatusTag status="accent">AI 推荐</StatusTag>
<StatusTag status="neutral">默认</StatusTag>
```

| status | 映射 antd color |
| --- | --- |
| success | green |
| warning | orange |
| danger | red |
| info / primary | blue |
| processing | cyan |
| accent | purple |
| neutral | default |

---

## 四、迁移红线（新代码写法）

| 不要 | 要 |
| --- | --- |
| `style={{ fontSize: 14 }}` | `<Text>` 或 `FONT_SIZE.base` |
| `style={{ color: '#5F6368' }}` | `<Text type="secondary">` 或 `COLORS.textSecondary` |
| `style={{ borderRadius: 8 }}` | 不写（themeConfig 已默认 8） |
| `<Card size="small" styles={{body:{padding:"8px 12px"}}}>` | `<SectionCard padding="sm">` |
| `<Tag color="orange">异常</Tag>` | `<StatusTag status="warning">异常</StatusTag>` |
| `<Modal width={640}>` | `<Modal width={MODAL_WIDTH.md}>` |
| `<Title level={4} style={{margin:0}}>...</Title>` | `<AppPageHeader title=...>` |

---

## 五、ESLint / PR Review 约定

- F-14：暂不上 ESLint custom rule（维护成本高）；PR 模板提醒
- F-18：Button size 暂不上 lint；Code Review 自觉
- 新增页面 PR 必须用 AppPageHeader / SectionCard / StatCard / FilterBar / StatusTag 5 件套

---

## 六、版本

| 版本 | 日期 | 改动 |
| --- | --- | --- |
| v1.0 | 2026-05-16 | D-009 初版，全站 33 页统一 |
