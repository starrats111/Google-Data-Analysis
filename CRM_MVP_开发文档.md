# CRM SaaS MVP — 可执行开发文档

> 最后更新：2026-03-20
> 状态：开发中，持续迭代

---

## 一、产品定位

联盟营销 CRM SaaS 平台，帮助联盟营销团队高效管理商家资源、Google Ads 投放和内容营销。

核心价值：商家同步 → 领取商家 → SemRush 竞品分析 → AI 广告文案 → Google Ads 创建 → 文章自动生成 → 数据看板 + AI 洞察，一站式闭环。

---

## 二、用户角色

| 角色 | 入口 | 权限 |
|------|------|------|
| 管理员 | 总控制台 `/admin` | 用户/团队管理、AI 配置、SemRush 配置、政策类别、站点管理、系统配置 |
| 组长 | 用户平台 `/user` | 用户全部功能 + 小组总览 + 员工管理 |
| 普通用户 | 用户平台 `/user` | 商家管理、广告创建、文章管理、数据看板、个人设置 |

- 用户由管理员注册创建，不开放自助注册
- 用户归属团队（teams），组长可查看组员数据
- 用户之间数据通过 `user_id` 隔离

---

## 三、平台模块总览

```
CRM SaaS MVP
├── 官网（静态展示 + 登录入口）
├── 总控制台（管理员 /admin）
│   ├── 仪表盘
│   ├── 用户管理
│   ├── 团队管理
│   ├── AI 配置（供应商 + 场景模型 + 系统默认）
│   ├── SemRush 竞品分析配置
│   ├── Google Ads 政策类别管理
│   ├── 站点管理（全局资源 + 服务器配置）
│   ├── 商家黑名单/推荐名单（Google Sheets 同步）
│   ├── 系统配置（后端 API + AI 服务 + 宝塔 SSH）
│   └── 操作日志
└── 用户平台（/user）
    ├── 商家管理（同步 + 领取 + 广告创建）
    ├── 数据中心（广告数据 + 结算查询）
    ├── AI 洞察（数据分析报告）
    ├── 文章管理（发布 + 列表）
    ├── 节日日历
    ├── 广告设置（全局默认）
    ├── 个人设置（平台连接 + MCC + 通知 + 密码）
    └── 团队管理（组长专属：小组总览 + 员工管理）
```

---

## 四、总控制台（管理员）

### 4.1 用户管理

- 创建用户（用户名、密码、角色、所属团队、显示名）
- 启用/禁用用户
- 查看用户列表
- 支持明文密码查看（仅管理员可见）
- 表：`users`

### 4.2 团队管理

- 创建/编辑团队（团队代码、团队名称）
- 指定组长
- 团队人员分配
- 表：`teams`

### 4.3 AI 配置

统一通过「AI 配置」页面管理，使用 `ai_providers` + `ai_model_configs` 双表结构：

#### 4.3.1 AI 供应商管理（ai_providers 表）

- 添加/编辑/禁用 AI 供应商（如哈基米中转等）
- 配置 API Key、API Base URL
- 支持多供应商共存
- 用户无感知，统一由管理员管理

#### 4.3.2 场景模型分配（ai_model_configs 表）

| 场景 | 说明 | 建议模型 |
|------|------|---------|
| ad_copy | 广告文案生成/补充 | 高质量模型 |
| article | 文章生成 | 高质量模型 |
| data_insight | 数据洞察分析 | 快速模型 |
| translate | 一键翻译 | 快速模型 |

- 每个场景可配置主模型 + 备用模型（priority 字段）
- 主模型失败自动 fallback 到备用模型
- 可配置 temperature、max_tokens 等参数

#### 4.3.3 AI 调用优先级

```
请求进入（场景：ad_copy / article / data_insight / translate）
    │
    ├─① 查询 ai_model_configs → 该场景是否有活跃模型？
    │   ├── 有 → 查询 ai_providers → 获取 API Key + Base URL
    │   │       ├── provider 有效 → 使用（支持 fallback 链）
    │   │       └── provider 无效 → 进入 ②
    │   └── 无 → 进入 ②
    │
    ├─② 查询 ai_providers 第一个可用供应商
    │   ├── 有 → 使用该 provider 的 key + 内置 fallback 模型链
    │   └── 无 → 抛出异常
    │
    ├── 调用 AI API（OpenAI 兼容格式）
    ├── 失败 → 按 priority 自动 fallback 到下一个模型
    └── 全部失败 → 抛出异常

内置 fallback 模型链（无 model_config 时）：
├── [特价]claude-sonnet-4-6
├── [福利]claude-sonnet-4-6
├── [官B]claude-sonnet-4-6
└── deepseek-chat
```

### 4.4 SemRush 竞品分析配置

存储在 `system_configs` 表，通过 3UE 代理调用 SemRush API：

| 配置键 | 说明 |
|--------|------|
| semrush_username | SemRush 用户名 |
| semrush_password | SemRush 密码 |
| semrush_user_id | SemRush 用户 ID |
| semrush_api_key | SemRush API Key |
| semrush_node | 代理节点 |
| semrush_database | 目标数据库（如 us） |

- 管理页面：`/admin/semrush-config`
- 实现：`src/lib/semrush-client.ts`（移植自数据分析平台的 `sem01_client.py`）

### 4.5 Google Ads 政策类别管理

独立表 `ad_policy_categories`，管理受限/禁止的广告品类：

- 类别代码、中英文名称、限制等级（restricted / prohibited）
- 投放限制规则：允许/禁止地区、年龄定位、认证要求
- 文案生成约束：给 AI 的规则（ad_copy_rules）
- 着陆页要求（landing_page_rules）
- 自动匹配规则：关键词列表（match_keywords）和域名列表（match_domains）

商家同步时自动检测流程：
1. 匹配域名和关键词 → 命中政策类别
2. 写入 `merchant_policy_reviews` 审核记录
3. 更新 `user_merchants.policy_status`（pending / clean / restricted / prohibited）

- 管理页面：`/admin/policy-categories`
- 实现：`src/lib/policy-review.ts`

### 4.6 站点管理（全局资源）

站点为**全局资源**，由管理员统一管理（非用户级）：

- 站点域名、远程路径（宝塔自动生成）、架构类型（自动检测）
- 部署方式：宝塔 SSH（bt_ssh）
- 文章数据文件路径（data_js_path）、变量名（article_var_name）、HTML 模板
- 站点验证状态
- 站点迁移任务（GitHub / Cloudflare → 宝塔），异步进度追踪

服务器配置（存储在 `system_configs`）：

| 配置键 | 说明 |
|--------|------|
| bt_ssh_host | 宝塔服务器 IP |
| bt_ssh_port | SSH 端口（默认 22） |
| bt_ssh_user | SSH 用户名（默认 ubuntu） |
| bt_ssh_password | SSH 密码 |
| bt_ssh_key_content | SSH 密钥文件内容（上传） |
| bt_site_root | 站点根目录（默认 /www/wwwroot） |

- 管理页面：`/admin/sites`（含 ServerConfigCard 组件）
- 表：`publish_sites`、`site_migrations`

### 4.7 商家黑名单/推荐名单

通过 Google Sheets 同步：

- `sheet_configs` 存储 Sheet URL（类型：violation / recommendation / merchant_sheet）
- `merchant_violations` 违规商家记录（商家名、平台、域名、违规原因、来源）
- `merchant_recommendations` 推荐商家记录（商家名、ROI参考、佣金率、结算率、备注）
- 同步后自动更新 `user_merchants` 的 `violation_status` / `recommendation_status`

- 管理页面：`/admin/merchant-sheet`

### 4.8 系统配置

键值对配置表 `system_configs`，按前缀分组管理：

| 分组 | 前缀 | 说明 |
|------|------|------|
| 后端服务器 | backend_ | API 地址（backend_api_url）、Token（backend_api_token） |
| 宝塔 SSH | bt_ | SSH 连接参数（见 4.6） |
| SemRush | semrush_ | 竞品分析配置（见 4.4） |
| MySQL 数据库 | mysql_ | 数据库连接参数（host/port/user/password/database/shadow_database） |

- 管理页面：`/admin/system-config`

### 4.9 操作日志

- 自动记录关键操作：登录、创建用户、领取商家、发布文章等
- 记录操作人、动作、目标类型/ID、详情、IP、User-Agent
- 管理员可查看全部日志
- 表：`operation_logs`

---

## 五、用户平台

### 5.1 商家管理（核心模块）

#### 5.1.1 商家同步

- 从 7 大联盟平台 API 同步商家列表到 `user_merchants`
- 同步时自动匹配政策类别（域名/关键词），更新 `policy_status`
- 同步时自动匹配违规/推荐状态
- 支持从 Google Sheets 同步商家数据（sheet-sync）

#### 5.1.2 联盟平台接入（7 个）

| 平台代码 | 全名 | 域名 |
|----------|------|------|
| CG | CollabGlow | collabglow.com |
| PM | Partnermatic | partnermatic.com |
| LH | LinkHaiTao | linkhaitao.com |
| RW | Rewardoo | rewardoo.com |
| LB | LinkBux | linkbux.com |
| BSH | BrandSparkHub | brandsparkhub.com |
| CF | CreatorFlare | creatorflare.com |

- 统一 Adapter 架构，每个平台一个 connector
- 每个平台账号可绑定一个发布站点（`platform_connections.publish_site_id`）
- 支持多账号（account_name 区分，如 RW1、RW2）

#### 5.1.3 领取商家 → 广告创建流程

```
Step 1：点击「领取」
    └── 弹窗：选择目标国家 + MCC 账户

Step 2：后端自动执行（异步）
    ├── 爬取商家网站元信息（URL 分析：品牌、品类、产品、卖点）
    ├── SemRush 竞品分析（关键词来源）
    │   ├── 获取竞品广告标题 → 去重后作为 Headlines 基础
    │   ├── 获取竞品广告描述 → 去重后作为 Descriptions 基础
    │   └── 获取竞品关键词 → 存入 keywords 表
    ├── AI 补充广告文案（SemRush 不足时）
    │   ├── Headlines 补充到 15 条（≤30字符，含折扣 + 物流必选项）
    │   ├── Descriptions 补充到 4 条（50-90字符）
    │   └── 根据目标国家选择语言和风格
    └── 同时异步启动文章生成

Step 3：跳转广告预览页 /user/ad-preview/[id]
    ├── 展示所有配置：文案、关键词、出价、预算等
    ├── 文案中英对照（headlines_zh / descriptions_zh）
    ├── 用户可修改本次配置
    ├── 可手动「从 SemRush 获取关键词」按钮
    └── 确认 → 提交 Google Ads（状态默认 ENABLED）

Step 4：文章自动生成（异步，利用 Step 3 的时间窗口）
    └── AI 根据商家信息 + 偏好设置生成推广文章
```

#### 5.1.4 广告投放设置（全局默认）

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 出价策略 | MAXIMIZE_CLICKS | 尽可能多的点击 |
| eCPC | 开 | 智能点击付费 |
| 最高 CPC | $0.3 | 单次点击上限 |
| 日预算 | $2 | 每日预算 |
| 搜索网络 | 开 | Google 搜索 |
| 合作伙伴 | 关 | 搜索合作伙伴 |
| 展示网络 | 关 | 展示广告网络 |
| 命名规则 | global | 全局序号 / 按平台（per_platform） |
| 命名前缀 | wj | 广告系列序号前缀 |

- 用户可随时修改默认设置，影响后续所有新建广告
- 表：`ad_default_settings`

#### 5.1.5 节日营销

- 输入国家代码 → 查询未来 15 天重大节日
- 点击节日 → 展开关联国家的同类节日
- 节日影响 AI 广告文案和文章生成的主题方向
- 表：`holiday_calendar`

### 5.2 数据中心

#### 5.2.1 广告数据看板

```
┌─────────────────────────────────────────────────────────┐
│ 顶部：MCC 账户选择 | 日期范围 | 筛选（状态/平台/MID/搜索）  │
├─────────────────────────────────────────────────────────┤
│ 汇总卡片：                                                │
│ 总花费 | 总佣金 | 总点击 | 总展示 | 平均CPC | ROI            │
│ 广告系列数 | 启用数 | 暂停数                                │
├─────────────────────────────────────────────────────────┤
│ 广告系列列表                                              │
│ 名称 | CID | 状态 | 日预算 | 花费 | 佣金 | 拒付 |           │
│ 点击 | CPC | 订单 | ROI | 操作（开启/暂停/编辑）              │
└─────────────────────────────────────────────────────────┘
```

- 日期范围选择（默认本月，东八区）
- 支持广告系列开启/暂停切换（同步到 Google Ads）
- 支持编辑预算和最高 CPC
- 数据同步：手动触发 Google Ads 数据拉取
- 表：`ads_daily_stats`、`campaigns`

#### 5.2.2 结算查询

- 联盟交易明细查看
- 按平台/账号/状态筛选
- 佣金统计（按账号维度汇总）
- 表：`affiliate_transactions`

### 5.3 AI 洞察报告

- 基于广告数据自动生成 AI 分析报告
- 支持三种类型：每日洞察 / 每周洞察 / 每月洞察
- 分页浏览历史报告
- 展示分析内容（Markdown 格式）和指标快照
- 入口：侧边栏「AI 洞察」菜单
- API：`GET /api/user/data-center/insights?type=daily&page=1&pageSize=10`
- 表：`ai_insights`

### 5.4 文章管理

#### 5.4.1 文章发布

- 选择发布站点 → 选择商家 → AI 生成推广文章
- 文章内容：标题、正文（HTML）、摘要、SEO 关键词、配图
- 根据目标国家自动选择语言
- 文章生成时读取用户 `prompt_preferences` 偏好（如有）
- 通过 SSH 发布到宝塔服务器

#### 5.4.2 文章列表

- 按状态筛选：生成中 / 待预览 / 已发布 / 失败
- 查看 / 编辑 / 删除
- 表：`articles`

### 5.5 个人设置

| Tab | 说明 |
|-----|------|
| 联盟平台连接 | 配置 7 个平台的 API Key，每个账号可绑定发布站点 |
| Google Ads MCC | MCC ID、名称、货币、服务账号 JSON、Sheet URL、Developer Token |
| 通知设置 | 按类型开关通知（系统 / 商家 / 文章 / 广告 / 预警） |
| 修改密码 | 修改登录密码 |

### 5.6 消息通知

- 系统自动推送通知（商家同步完成、文章发布成功、广告状态变更等）
- 按类型分类：system / merchant / article / ad / alert
- 未读计数、全部已读、逐条已读
- 用户可按类型开关通知偏好
- 表：`notifications`、`notification_preferences`

### 5.7 团队管理（组长专属）

- 小组总览：查看组员数据汇总
- 员工管理：查看组员列表、组员数据详情
- 仅组长（team leader）可见

---

## 六、AI 服务层架构

```
src/lib/ai-service.ts — 统一 AI 调用接口

核心函数：
├── callAiWithFallback(scene, messages, maxTokens)
│   ├── getSceneModels(scene) → 获取模型链
│   ├── callAi(config, messages) → OpenAI 兼容 API 调用
│   └── 逐个尝试，失败自动 fallback
│
├── padHeadlines(existing, merchantName, country, count=15)
│   └── SemRush 标题不足时，AI 补充到 15 条
│
└── padDescriptions(existing, merchantName, country, count=4)
    └── SemRush 描述不足时，AI 补充到 4 条

国家语言适配：
├── US: English (US) — 直接、行动导向、强调价值和优惠
├── UK: English (UK) — 含蓄、品质导向、英式拼写
├── DE: German — 严谨、技术参数导向
├── FR: French — 优雅、强调设计美学
├── JP: Japanese — 礼貌、详细、强调服务
└── ... 更多国家映射
```

---

## 七、SemRush 集成（关键词来源）

移植自数据分析平台的 `sem01_client.py`，通过 3UE 代理调用：

```
领取商家时自动触发（或广告预览页手动点击「从 SemRush 获取关键词」）
    │
    ├── SemRushClient.fromConfig()
    │   └── 读取 system_configs 的 semrush_* 配置
    ├── 登录 SemRush（通过 3UE 代理）
    ├── 查询竞品广告数据
    │   ├── 竞品标题 → 去重 → Headlines 基础（≤30字符过滤）
    │   ├── 竞品描述 → 去重 → Descriptions 基础（≤90字符过滤）
    │   └── 竞品关键词 → 存入 keywords 表
    └── 不足时 AI 补充（padHeadlines / padDescriptions）
```

> **重要**：关键词来源为 **SemRush 竞品分析**，非 Google Keyword Planner。

---

## 八、异步任务与定时任务

| 任务 | 触发方式 | 说明 |
|------|---------|------|
| 广告文案生成 | 领取商家时异步 | SemRush 竞品 + AI 补充 |
| 文章生成 | 领取商家时异步 | AI 根据商家信息 + 用户偏好生成 |
| Google Ads 创建 | 广告预览确认后 | 通过 Google Ads API 创建广告系列 |
| 广告数据同步 | 手动触发 / 定时 | 从 Google Ads API / Google Sheets 拉取到 ads_daily_stats |
| 联盟交易同步 | 手动触发 / 定时 | 从联盟平台 API 拉取到 affiliate_transactions |
| 商家黑名单同步 | 手动触发 | 从 Google Sheets 同步违规/推荐名单 |
| 政策审核 | 商家同步时自动 | 匹配政策类别，更新审核状态 |

---

## 九、数据库概览

共 29 张表（Prisma schema 中的 model）：

| # | 表名 | 所属模块 | 数据来源 |
|---|------|---------|---------|
| 1 | teams | 团队管理 | 管理员创建 |
| 2 | users | 用户管理 | 管理员创建 |
| 3 | ai_providers | AI 配置 | 管理员配置 |
| 4 | ai_model_configs | AI 配置 | 管理员配置 |
| 5 | system_configs | 系统配置 | 管理员配置（含 SemRush / SSH / MySQL 等） |
| 6 | platform_connections | 个人设置 | 用户配置 |
| 7 | user_merchants | 商家管理 | 联盟平台 API 同步 |
| 8 | merchant_violations | 商家黑名单 | Google Sheets 同步 |
| 9 | merchant_recommendations | 推荐商家 | Google Sheets 同步 |
| 10 | sheet_configs | 表格配置 | 管理员配置 |
| 11 | ad_default_settings | 广告设置 | 用户配置 |
| 12 | holiday_calendar | 节日日历 | 外部数据 / 管理员维护 |
| 13 | campaigns | 广告系列 | 领取商家时创建 → Google Ads |
| 14 | ad_groups | 广告组 | 随 campaign 创建（Google Ads 必需层级） |
| 15 | keywords | 关键词 | SemRush 竞品分析获取 |
| 16 | ad_creatives | 广告素材 | SemRush 竞品 + AI 补充生成 |
| 17 | publish_sites | 站点管理 | 管理员创建（全局资源） |
| 18 | site_migrations | 站点迁移 | 管理员触发（异步任务） |
| 19 | articles | 文章 | AI 生成 |
| 20 | ads_daily_stats | 广告每日数据 | Google Ads API / Sheets 同步 |
| 21 | google_mcc_accounts | MCC 账户 | 用户配置 |
| 22 | mcc_cid_accounts | MCC 子账户 | Google Ads API 同步 |
| 23 | affiliate_transactions | 联盟交易 | 联盟平台 API 同步 |
| 24 | notifications | 消息通知 | 系统自动生成 |
| 25 | notification_preferences | 通知偏好 | 用户配置 |
| 26 | ai_insights | AI 洞察报告 | AI 分析生成 |
| 27 | operation_logs | 操作日志 | 系统自动记录 |
| 28 | ad_policy_categories | 政策类别 | 管理员配置 |
| 29 | merchant_policy_reviews | 政策审核记录 | 商家同步时自动生成 |

> 详细字段定义见 `CRM_MVP_数据库设计.sql` 和 `prisma/schema.prisma`

---

## 十、关键设计决策记录

| 决策 | 结论 | 理由 |
|------|------|------|
| 数据隔离 | 同库 user_id 隔离 | 运维简单，效果等同 |
| 广告创建 | 领取商家时自动创建 | 减少用户操作步骤 |
| 关键词来源 | SemRush 竞品分析 | 移植自 sem01，真实竞品数据更精准 |
| 广告文案 | SemRush 竞品标题优先 + AI 补充 | 先用真实数据，不足时 AI 补到 15+4 |
| AI 配置 | 统一管理（ai_providers + ai_model_configs） | 供应商 + 场景模型双表，fallback 链清晰 |
| 站点管理 | 全局资源，管理员统一管理 | 非用户级，统一部署管理 |
| 部署方式 | 宝塔 SSH（bt_ssh） | 直接操作服务器文件 |
| 货币 | 统一 USD 展示 | 简化数据对比 |
| AI 偏好 | prompt_preferences 表已删除 | MVP 简化，文章生成使用默认值 |
| 外键 | 不使用 | 应用层保证一致性 |
| 删除 | 软删除 | 全表启用 is_deleted |
| 政策审核 | 商家同步时自动检测 | 域名/关键词匹配，自动分类 |
| 商家黑名单 | Google Sheets 同步 | 便于业务团队维护 |
| 广告组 | 保留 ad_groups 表 | Google Ads API 必需中间层（Campaign → AdGroup → Ad） |
| 广告状态同步 | google_status 字段 | 区分本地状态和 Google Ads 侧真实状态 |
| 平台账号 | 多账号支持 | account_name 区分（如 RW1、RW2），绑定发布站点 |

---

## 十一、已删除/变更的原设计

| 原设计 | 变更 | 原因 |
|--------|------|------|
| crawl_tasks 表 | **已删除** | 爬取逻辑简化为 URL 分析，无需独立跟踪表 |
| exchange_rates 表 | **已删除** | 汇率转换改为实时处理 |
| prompt_preferences 表 | **已删除** | MVP 简化，文章生成使用默认值 |
| AI 双轨制配置 | **改为单一管理** | 移除 system_configs 的 AI 键，统一通过「AI 配置」页面管理 |
| publish_sites 用户级 | **改为全局资源** | 管理员统一管理站点，用户通过 platform_connections 绑定 |
| Keyword Planner 关键词 | **改用 SemRush** | sem01 竞品分析数据更精准 |
| ads_daily_stats 字段 | **精简** | 移除 roas/original_currency/exchange_rate，新增 rejected_commission/orders/data_source |
| articles 字段 | **新增** | 新增 excerpt/merchant_name/tracking_link/meta_title/meta_description |
