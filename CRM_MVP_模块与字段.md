# CRM SaaS MVP — 功能模块与核心字段

> 最后更新：2026-03-20
> 与 `prisma/schema.prisma` 同步，共 30 张表

---

## 一、总控制台（管理员）

### 1.1 团队管理 `teams`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| team_code | 团队代码（唯一） |
| team_name | 团队名称 |
| leader_id | 组长 users.id |

### 1.2 用户管理 `users`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| username | 用户名（唯一） |
| password_hash | 密码哈希 |
| plain_password | 明文密码（仅管理员可见） |
| role | 角色：admin / user |
| status | 状态：active / disabled |
| team_id | 所属团队 |
| display_name | 显示名称 |

### 1.3 AI 供应商 `ai_providers`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| provider_name | 供应商名称 |
| api_key | API Key（加密存储） |
| api_base_url | 自定义 API 地址 |
| status | 启用 / 禁用 |

### 1.4 AI 场景模型分配 `ai_model_configs`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| scene | 场景：ad_copy / article / data_insight / translate |
| provider_id | 关联 ai_providers.id |
| model_name | 模型名称 |
| max_tokens | 最大输出 token |
| temperature | 温度参数 |
| is_active | 是否为该场景当前生效模型 |
| priority | 优先级（1=主模型，2+=备用 fallback） |

> AI 配置为**双轨制**：ai_model_configs 优先，回退到 system_configs 的 ai_* 默认配置。

### 1.5 系统配置 `system_configs`

| 字段 | 说明 |
|------|------|
| config_key | 配置键（唯一） |
| config_value | 配置值 |
| description | 说明 |

**主要配置分组：**

| 前缀 | 说明 | 主要 key |
|------|------|---------|
| ai_ | AI 服务默认配置 | ai_default_provider, ai_default_model, ai_api_key, ai_base_url, ai_max_tokens, ai_temperature |
| semrush_ | SemRush 竞品分析 | semrush_username, semrush_password, semrush_user_id, semrush_api_key, semrush_node, semrush_database |
| bt_ | 宝塔 SSH | bt_ssh_host, bt_ssh_port, bt_ssh_user, bt_ssh_password, bt_ssh_key_content, bt_site_root |
| backend_ | 后端服务器 | backend_api_url, backend_api_token |

### 1.6 Google Ads 政策类别 `ad_policy_categories`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| category_code | 类别代码（唯一，如 alcohol / gambling） |
| category_name | 中文名 |
| category_name_en | 英文名 |
| restriction_level | 限制等级：restricted / prohibited |
| description | 政策说明 |
| allowed_regions | JSON，允许投放的国家 |
| blocked_regions | JSON，禁止的国家 |
| age_targeting | 年龄定位："18+" / "21+" |
| requires_cert | 是否需要 Google 认证 |
| ad_copy_rules | JSON，文案生成约束 |
| landing_page_rules | JSON，着陆页要求 |
| match_keywords | JSON，自动匹配关键词 |
| match_domains | JSON，自动匹配域名 |
| sort_order | 排序 |

### 1.7 商家政策审核记录 `merchant_policy_reviews`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| merchant_name | 商家名称 |
| merchant_domain | 商家域名 |
| platform | 平台代码 |
| policy_category_id | 匹配到的政策类别 id |
| policy_status | 审核结果：clean / restricted / prohibited |
| matched_rule | 匹配到的关键词/规则 |
| review_method | 审核方式：auto / manual |
| reviewed_at | 审核时间 |
| notes | 备注 |

### 1.8 站点管理 `publish_sites`（全局资源）

| 字段 | 说明 |
|------|------|
| id | 主键 |
| site_name | 站点名称 |
| domain | 域名（唯一） |
| site_path | 宝塔远程路径（自动生成） |
| site_type | 架构类型（自动检测） |
| data_js_path | 文章数据文件路径（默认 js/articles-index.js） |
| article_var_name | 文章变量名 |
| article_html_pattern | 文章 HTML 模板 |
| deploy_type | 部署方式：bt_ssh |
| deploy_config | JSON，部署配置 |
| status | active / inactive |
| verified | 是否已验证 |

### 1.9 站点迁移 `site_migrations`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| site_id | 关联 publish_sites.id |
| domain | 域名 |
| source_type | 来源：github / cloudflare |
| source_ref | 源 URL |
| status | pending / cloning / dns / ssl / verifying / done / failed |
| progress | 进度 0-100 |
| step_detail | 当前步骤详情 |
| error_message | 错误信息 |
| created_by | 管理员 user_id |

### 1.10 商家黑名单/推荐名单

#### `sheet_configs`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| config_type | 类型：violation / recommendation / merchant_sheet（唯一） |
| sheet_url | Google Sheets URL |
| last_synced_at | 最后同步时间 |
| updated_by | 更新人 users.id |

#### `merchant_violations`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| merchant_name | 商家名称 |
| platform | 平台 |
| merchant_domain | 商家域名 |
| violation_reason | 违规原因 |
| violation_time | 违规时间 |
| source | 名单来源 |
| upload_batch | 上传批次号 |

#### `merchant_recommendations`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| merchant_name | 商家名称 |
| roi_reference | ROI 参考值 |
| commission_info | 佣金率 |
| settlement_info | 结算率 |
| remark | 备注 |
| share_time | 分享时间 |
| upload_batch | 上传批次号 |

### 1.11 操作日志 `operation_logs`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| user_id | 操作人 |
| username | 操作人用户名 |
| action | 动作：login / create_user / claim_merchant 等 |
| target_type | 目标类型：user / merchant / article 等 |
| target_id | 目标 ID |
| detail | 操作详情 JSON |
| ip_address | IP 地址 |
| user_agent | User-Agent |

---

## 二、用户平台 — 商家管理

### 2.1 联盟平台连接 `platform_connections`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| user_id | 所属用户 |
| platform | 平台代码：CG / PM / LH / RW / LB / BSH / CF |
| account_name | 账号名称（如 RW1, RW2） |
| api_key | API 密钥 |
| publish_site_id | 绑定的发布站点 |
| status | connected / expired / error |
| last_synced_at | 最后同步时间 |

### 2.2 商家库 `user_merchants`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| user_id | 所属用户（数据隔离） |
| platform | 来源平台 |
| merchant_id | 平台商家 ID |
| merchant_name | 商家名称 |
| merchant_url | 商家网址 |
| category | 品类 |
| commission_rate | 佣金率 |
| cookie_duration | Cookie 有效期（天） |
| supported_regions | JSON，支持地区列表 |
| status | available / claimed |
| claimed_at | 领取时间 |
| target_country | 目标国家 |
| holiday_name | 关联节日 |
| tracking_link | 联盟追踪链接 |
| campaign_link | 联盟平台推广链接 |
| violation_status | normal / violated（从 Sheets 同步） |
| violation_time | 违规时间 |
| recommendation_status | normal / recommended（从 Sheets 同步） |
| recommendation_time | 推荐时间 |
| policy_status | pending / clean / restricted / prohibited（自动检测） |
| policy_category_code | 匹配到的政策类别代码 |
| platform_connection_id | 关联到具体平台账号 |

### 2.3 广告默认设置 `ad_default_settings`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| user_id | 所属用户（唯一） |
| bidding_strategy | 出价策略（默认 MAXIMIZE_CLICKS） |
| ecpc_enabled | eCPC 开关 |
| max_cpc | 默认 CPC（0.30 USD） |
| daily_budget | 默认日预算（2.00 USD） |
| network_search | 搜索网络 |
| network_partners | 合作伙伴 |
| network_display | 展示网络 |
| naming_rule | 命名规则：global / per_platform |
| naming_prefix | 序号前缀（默认 wj） |

### 2.4 节日日历 `holiday_calendar`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| country_code | 国家代码 |
| holiday_name | 节日名称 |
| holiday_date | 节日日期 |
| holiday_type | public / commercial / religious |
| related_holidays | JSON，关联的其他国家同类节日 |

---

## 三、用户平台 — 广告（领取商家时自动创建）

### 3.1 广告系列 `campaigns`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| user_id | 所属用户 |
| user_merchant_id | 关联商家 |
| google_campaign_id | Google Ads 广告系列 ID |
| mcc_id | MCC 账户 ID |
| customer_id | CID（子账户） |
| campaign_name | 广告系列名称 |
| daily_budget | 每日预算 |
| bidding_strategy | 出价策略 |
| max_cpc_limit | 最高 CPC |
| target_country | 目标国家 |
| geo_target | 地理定位代码 |
| language_id | 语言代码 |
| network_search | 搜索网络 |
| network_partners | 搜索合作伙伴 |
| network_display | 展示网络 |
| status | 本地状态：active / paused / removed |
| google_status | Google 侧状态：ENABLED / PAUSED / REMOVED |
| last_google_sync_at | 最后 Google 同步时间 |

### 3.2 广告组 `ad_groups`（Google Ads 必需层级）

| 字段 | 说明 |
|------|------|
| id | 主键 |
| campaign_id | 关联广告系列 |
| google_ad_group_id | Google Ads 广告组 ID |
| ad_group_name | 广告组名称 |
| keyword_match_type | 默认匹配：PHRASE / BROAD / EXACT |

> ad_groups 是 Google Ads API 的必需中间层级（Campaign → AdGroup → Ad/Keywords），不可移除。

### 3.3 关键词 `keywords`（来源：SemRush 竞品分析）

| 字段 | 说明 |
|------|------|
| id | 主键 |
| ad_group_id | 关联广告组 |
| keyword_text | 关键词文本 |
| match_type | 匹配类型：PHRASE / BROAD / EXACT |
| is_negative | 是否为否定关键词 |
| avg_monthly_searches | 月均搜索量 |
| competition | 竞争程度：LOW / MEDIUM / HIGH |
| suggested_bid | 建议出价 |

> 关键词数据来源为 **SemRush 竞品分析**（移植自 sem01_client.py），非 Google Keyword Planner。

### 3.4 广告素材 `ad_creatives`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| ad_group_id | 关联广告组 |
| final_url | 着陆页 URL |
| display_path1 | 显示路径 1 |
| display_path2 | 显示路径 2 |
| headlines | JSON，≤15 条标题（SemRush 竞品 + AI 补充，≤30 字符） |
| descriptions | JSON，≤4 条描述（SemRush 竞品 + AI 补充，≤90 字符） |
| headlines_zh | JSON，标题中文参考翻译 |
| descriptions_zh | JSON，描述中文参考翻译 |
| sitelinks | JSON，站点链接 |
| callouts | JSON，宣传信息 |
| image_urls | JSON，图片素材 URL |
| logo_url | 商家 Logo URL |
| selling_points | JSON，商家卖点 |

---

## 四、用户平台 — 文章管理

### 4.1 文章 `articles`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| user_id | 所属用户 |
| user_merchant_id | 关联商家 |
| publish_site_id | 发布站点 |
| title | 文章标题（AI 生成） |
| slug | URL 友好路径 |
| content | 文章正文（HTML/LongText） |
| excerpt | 文章摘要 |
| language | 文章语言（根据目标国家） |
| keywords | JSON，SEO 关键词 |
| images | JSON，文章配图 URL 列表 |
| status | generating / preview / published / failed |
| published_at | 发布时间 |
| published_url | 发布后的外部 URL |
| merchant_name | 商家名称 |
| tracking_link | 追踪链接 |
| meta_title | SEO 标题 |
| meta_description | SEO 描述 |

---

## 五、用户平台 — 数据中心

### 5.1 广告每日数据 `ads_daily_stats`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| user_id | 所属用户 |
| user_merchant_id | 关联商家 |
| campaign_id | 关联广告系列 |
| date | 日期 |
| budget | 当日预算（USD） |
| cost | 实际花费（USD） |
| clicks | 点击数 |
| impressions | 展示数 |
| cpc | 单次点击费用（USD） |
| conversions | 转化数 |
| commission | 佣金（USD） |
| rejected_commission | 拒付佣金（USD） |
| roi | 投资回报率 |
| orders | 订单数 |
| data_source | 数据来源：sheet / api |

### 5.2 联盟交易明细 `affiliate_transactions`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| user_id | 所属用户 |
| user_merchant_id | 关联商家 |
| campaign_id | 关联广告系列 |
| platform_connection_id | 关联平台账号 |
| platform | 平台代码 |
| merchant_id | 平台商家 ID |
| merchant_name | 商家名称 |
| transaction_id | 交易 ID（平台+交易ID唯一） |
| transaction_time | 交易时间 |
| order_amount | 订单金额 |
| commission_amount | 佣金金额 |
| currency | 货币（默认 USD） |
| status | pending / approved / rejected |
| raw_status | 平台原始状态 |

### 5.3 AI 洞察报告 `ai_insights`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| user_id | 所属用户 |
| insight_date | 洞察日期 |
| insight_type | daily / weekly / monthly |
| content | AI 分析内容（Markdown/LongText） |
| metrics_snapshot | JSON，生成时的指标快照 |

---

## 六、用户平台 — 个人设置

### 6.1 Google Ads 账户 `google_mcc_accounts`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| user_id | 所属用户 |
| mcc_id | MCC 账户 ID |
| mcc_name | MCC 名称 |
| currency | 货币：USD / CNY |
| service_account_json | 服务账号凭证 JSON（加密存储） |
| sheet_url | MCC 脚本导出的 Google Sheet URL |
| developer_token | Google Ads API Developer Token |
| is_active | 是否启用 |

### 6.2 MCC 子账户 `mcc_cid_accounts`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| mcc_account_id | 关联 google_mcc_accounts.id |
| customer_id | Google Ads CID |
| customer_name | CID 账户名称 |
| is_available | Y=可用 N=已被广告系列占用 |
| status | active / suspended / cancelled |
| last_synced_at | 最后同步时间 |

### 6.3 消息通知 `notifications`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| user_id | 所属用户 |
| type | system / merchant / article / ad / alert |
| title | 通知标题 |
| content | 通知内容 |
| is_read | 是否已读 |

### 6.4 通知偏好 `notification_preferences`

| 字段 | 说明 |
|------|------|
| id | 主键 |
| user_id | 所属用户（唯一） |
| notify_system | 系统通知开关 |
| notify_merchant | 商家通知开关 |
| notify_article | 文章通知开关 |
| notify_ad | 广告通知开关 |
| notify_alert | 预警通知开关 |

### 6.5 AI 风格偏好 `prompt_preferences`（前端入口已移除）

| 字段 | 说明 |
|------|------|
| id | 主键 |
| user_id | 所属用户（唯一） |
| ad_writing_style | 写作风格：professional / casual / urgent / storytelling |
| ad_emphasis_tags | JSON，重点标签 |
| ad_extra_prompt | 广告自定义补充提示词 |
| article_type | 文章类型：review / guide / comparison / news |
| article_length | 文章长度：short / medium / long |
| article_seo_focus | JSON，SEO 侧重标签 |
| article_extra_prompt | 文章自定义补充提示词 |

> 前端个人设置页已移除此 Tab。后端表和 API 保留，文章生成服务 `article-gen.ts` 读取偏好时使用默认值。

---

## 七、后台服务模块

| 模块 | 职责 |
|------|------|
| 联盟平台 Adapter × 7 | CG / PM / LH / RW / LB / BSH / CF 商家数据拉取 |
| SemRush 客户端 | 竞品分析（标题 + 描述 + 关键词），移植自 sem01_client.py |
| Google Ads 服务 | 广告创建 + 数据拉取 + 状态同步 |
| AI 服务层 | 统一调度，双轨制配置（ai_model_configs + system_configs） |
| 文章生成服务 | AI 生成 + 去 AI 味 + 链接后处理 |
| 远程发布服务 | 通过 SSH 发布到宝塔服务器 |
| 政策审核服务 | 商家同步时自动匹配政策类别 |
| 商家名单同步 | Google Sheets → merchant_violations / merchant_recommendations |
