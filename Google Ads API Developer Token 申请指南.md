# Google Ads API Developer Token — Basic Access 申请表单填写指南

> 申请地址：https://support.google.com/adspolicy/contact/new_token_application
>
> 适用公司：温州丰度广告传媒有限公司 (Wenzhou Fengdu Advertising & Media Co., Ltd.)
>
> 更新时间：2026-03-31
>
> ⚠️ 提交前务必先完成"申请前准备"中的所有步骤

---

## 一、申请前准备（提交表单之前必须做完）

### 1.1 确认 API Center 信息

1. 登录 Google Ads Manager 账户（MCC）
2. 点击顶部 **TOOLS & SETTINGS** → **SETUP** → **API Center**
3. 检查并更新以下信息：
   - **API Contact Email** → 改为 `admin@google-data-analysis.top`（企业域名邮箱）
   - **Company Type** → 选择最符合你使用方式的类型（通常是 "Internal tool" 或 "Advertiser"）
   - **Company Name** → `Wenzhou Fengdu Advertising & Media Co., Ltd.`
   - **Company URL** → `https://google-data-analysis.top`

### 1.2 确认 MCC 下已关联账户

确保你要管理的 Google Ads 账户已经作为子账户关联到你的 MCC 下。

### 1.3 准备设计文档

需要上传一份 PDF/DOC/RTF 格式的设计文档（见本文"第三部分"的完整内容）。

建议：将本文第三部分的内容复制到 Word，导出为 PDF 后上传。

---

## 二、表单逐题填写指南

> 表单地址：https://support.google.com/adspolicy/contact/new_token_application

---

### 第 1 题：My API contact email in the Google Ads API Center is accurate and up-to-date.

**选择**：✅ Yes

**注意**：提交前确保 API Center 中的联系邮箱已改为 `admin@google-data-analysis.top`

---

### 第 2 题：Please provide the Google Ads manager account (MCC) ID associated with your developer token.

**填写**：你的 MCC 账户 ID

格式示例：`123-456-7890`

**注意**：登录 Google Ads 后右上角可以看到。必须是 Manager 账户的 ID，不是普通广告账户的 ID。

---

### 第 3 题：Please provide your contact email address.

**填写**：

```
admin@google-data-analysis.top
```

**注意**：
- 必须使用企业域名邮箱，这是上次被驳回的核心原因之一
- 不要用 Gmail 或 QQ 等个人邮箱
- 确保这个邮箱能正常收件（已在 Zoho Mail 配置）

---

### 第 4 题：Do you have an ongoing relationship with a representative at Google?

**选择**：No（除非你有 Google 的客户经理联系人）

如果有，填写对方的 @google.com 邮箱。

---

### 第 5 题：Please provide the URL for your company's primary website.

**填写**：

```
https://google-data-analysis.top
```

**注意**：
- 网站必须能正常访问（已验证 200 OK）
- 网站上已有 About Us、Privacy Policy、Terms of Service（已部署）
- Google 审核人员会实际访问这个网站

---

### 第 6 题：Please briefly describe your company's business model and how you use Google Ads.

**填写**（直接复制）：

```
Wenzhou Fengdu Advertising & Media Co., Ltd. is an affiliate marketing company. Our business model involves sourcing partner merchants from major international affiliate networks — including Commission Junction (CJ), Impact, ShareASale, Awin, and Rakuten — and running Google Search Advertising campaigns to drive qualified traffic to those merchants' websites. We earn commissions on resulting sales and conversions generated through our campaigns.

Our internal team of advertising professionals manages all campaigns exclusively in-house across multiple international markets and languages. To operate this affiliate marketing business at scale, we developed an internal platform called Ad Automation CRM that integrates with the Google Ads API. The platform streamlines our full workflow from merchant onboarding through campaign management and ROI reporting. It enables our team to:

1. Affiliate Merchant Management — Track and manage partner merchants sourced from 7 major international affiliate networks; assign merchants to team members and monitor campaign lifecycle.
2. Campaign Creation — Fully automated Google Search campaign setup including daily budget allocation, bidding strategy configuration (Manual CPC, Target CPA, Maximize Clicks), geographic and language targeting, ad group creation, Responsive Search Ad composition, and keyword management with match type selection.
3. Budget & Bid Control — Real-time campaign budget adjustments and ad group CPC bid updates from a centralized dashboard.
4. Campaign Status Management — Enable or pause campaigns with real-time status synchronization to Google Ads.
5. Performance & ROI Analytics — Daily performance metrics (cost, clicks, impressions, average CPC, conversions) combined with affiliate commission data for ROI calculation and data-driven optimization across all managed merchants.
6. MCC Account Management — Unified management of multiple Google Ads sub-accounts under our MCC manager accounts, with per-merchant spending attribution and CID availability tracking.
7. Ad Asset Management — Campaign-level asset creation and management: sitelinks, callouts, promotions, price extensions, call extensions, structured snippets, and image assets.
8. Content Automation — AI-powered SEO article generation and multi-site publishing to support organic promotion of affiliate merchants alongside our paid search campaigns.
9. Data Synchronization — Automated daily synchronization of campaign metrics and status between Google Ads and our internal database for consolidated reporting.

All campaigns are managed exclusively by our internal employees. We do not offer this platform or advertising management services to third-party clients. Our website at https://google-data-analysis.top provides full details about our company and business model, including our About Us page, Privacy Policy, and Terms of Service.
```

---

### 第 7 题：Design documentation of your tool (.pdf, .doc, or .rtf file formats only)

**上传**：将本文"第三部分"的内容制作成 PDF 上传。

---

### 第 8 题：Who will have access to the Google Ads API tool you are creating?

**选择**：Internal users only（仅内部用户）

如果有更详细的选项，选择类似 "Only people within my company" 的选项。

---

### 第 9 题：Do you plan to use your Google Ads API token with a tool developed by someone else?

**选择**：No

---

### 第 10 题：Do you plan to use your token for App Conversion Tracking and Remarketing API?

**选择**：No

---

### 第 11 题：Which Google Ads campaign types does your tool support?

**填写**：

```
Search
```

**注意**：只写你实际使用的广告类型。当前系统只创建 Search 类型的广告系列。

---

### 第 12 题：Which of the following Google Ads capabilities does your tool provide?

**勾选**（选择所有适用的）：

- ✅ Campaign management（广告系列管理）
- ✅ Reporting（报告）
- ✅ Account management（账户管理）
- ✅ Bid and budget management（出价和预算管理）

如果有 "Other" 选项，补充填写：

```
Ad asset management (sitelinks, callouts, promotions, price extensions, call extensions, structured snippets, image assets), automated daily data synchronization, campaign status control (enable/pause).
```

---

### 最后两个确认框

- ✅ I acknowledge that all the information above is accurate.
- ✅ I accept the Terms and Conditions...

---

## 三、设计文档内容（复制到 Word → 导出 PDF → 上传）

以下是完整的设计文档内容，按照 Google 官方模板格式编写：

---

# Ad Automation CRM — API Tool Design Document

**Company**: Wenzhou Fengdu Advertising & Media Co., Ltd.

**Website**: https://google-data-analysis.top

**Contact**: admin@google-data-analysis.top

**Date**: April 2, 2026

---

## 1. Tool Overview

Ad Automation CRM is an internal affiliate marketing operations platform developed by Wenzhou Fengdu Advertising & Media Co., Ltd. The tool is designed to help our internal team of advertising professionals efficiently manage the full affiliate marketing workflow — from merchant sourcing through Google Ads campaign management, performance tracking, and ROI reporting — at scale.

**Key characteristics:**
- Internal tool, not offered as a third-party service or SaaS product
- Used exclusively by our company's authorized employees
- Integrates with Google Ads API v23 via REST endpoints
- Deployed on our own infrastructure at https://google-data-analysis.top

---

## 2. Company Background

Wenzhou Fengdu Advertising & Media Co., Ltd. (温州丰度广告传媒有限公司) is an affiliate marketing company based in Wenzhou, Zhejiang, China. Our business involves sourcing partner merchants from major international affiliate networks (Commission Junction, Impact, ShareASale, Awin, Rakuten, and others) and running Google Search Advertising campaigns to drive qualified traffic to those merchants. We earn commissions on sales and conversions generated through our campaigns.

Our internal team manages all campaigns in-house across multiple international markets and languages. To operate at scale, we built the Ad Automation CRM to automate and consolidate the entire affiliate marketing campaign management workflow.

**Address:** Room 1110-2, Building 29, Huahong Xin Plaza, Xincheng Avenue, Luoyang Town, Taishun County, Wenzhou, Zhejiang, China

**Team size:** Approximately 30+ advertising professionals

---

## 3. Affiliate Marketing Business Model and Google Ads Integration

Our company operates as an affiliate marketing business. The workflow that this tool supports is as follows:

1. **Merchant Sourcing** — Our team identifies partner merchants from major international affiliate networks (Commission Junction, Impact, ShareASale, Awin, Rakuten, and others) and onboards them into our internal platform.
2. **Campaign Assignment** — Each merchant is assigned to an advertising team member, who is responsible for creating and managing Google Search campaigns to promote that merchant.
3. **Google Ads Campaign Creation** — Using our Ad Automation CRM, the team member creates a Google Search campaign via the Google Ads API: setting budgets, bidding strategies, geographic/language targeting, ad groups, Responsive Search Ads, and keywords.
4. **Performance Monitoring** — The platform fetches daily performance data (cost, clicks, impressions, conversions) from Google Ads and combines it with affiliate commission data to calculate ROI per merchant.
5. **Optimization** — Based on performance data, the team adjusts budgets, bids, and campaign status (enable/pause) as needed.
6. **Content Support** — Alongside paid search, our platform generates AI-powered SEO articles for each merchant and publishes them to our content sites to support organic traffic.

All campaigns are run and managed exclusively by our internal employees. We do not offer advertising management services to third-party clients, nor do we resell access to this tool.

---

## 4. Google Ads API Features Used

Our tool uses the Google Ads API v23 through the following REST endpoints:

- `POST /customers/{customerId}/googleAds:searchStream` — for querying campaign data, metrics, and account information
- `POST /customers/{customerId}/googleAds:mutate` — for creating and modifying campaigns, ad groups, ads, keywords, and assets

### 4.1 Campaign Management

| Feature | API Operation | Description |
|---------|--------------|-------------|
| Create campaign | `campaign_operation.create` | Create Search campaigns with budget, bidding strategy (Manual CPC, Target CPA, Maximize Clicks), and network settings |
| Create campaign budget | `campaign_budget_operation.create` | Set daily budget for each campaign |
| Set targeting | `campaign_criterion_operation.create` | Configure geographic location and language targeting |
| Create ad group | `ad_group_operation.create` | Create SEARCH_STANDARD ad groups with CPC bid |
| Create ads | `ad_group_ad_operation.create` | Create Responsive Search Ads with headlines, descriptions, and final URLs |
| Add keywords | `ad_group_criterion_operation.create` | Add keywords with Broad, Phrase, or Exact match types |
| Remove campaign | `campaign_operation.remove` | Remove campaigns when republishing |

### 4.2 Budget and Bid Control

| Feature | API Operation | Description |
|---------|--------------|-------------|
| Update budget | `campaign_budget_operation.update` | Adjust campaign daily budget (amount_micros) in real-time |
| Update CPC bids | `ad_group_operation.update` | Update max CPC bids (cpc_bid_micros) across all ad groups in a campaign |

### 4.3 Campaign Status Control

| Feature | API Operation | Description |
|---------|--------------|-------------|
| Enable/Pause campaign | `campaign_operation.update` | Toggle campaign status between ENABLED and PAUSED |
| Verify status | `searchStream` query | Query campaign.status after update to confirm the change took effect |

### 4.4 Performance Reporting and Analytics

| Feature | GAQL Query | Description |
|---------|-----------|-------------|
| Daily metrics | `SELECT campaign.id, campaign.name, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.average_cpc, metrics.conversions, segments.date FROM campaign WHERE metrics.cost_micros > 0` | Fetch daily performance data |
| Date range reports | Same query with `segments.date BETWEEN '{start}' AND '{end}'` | Historical performance analysis |
| Campaign status | `SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros FROM campaign` | Current state overview |

### 4.5 MCC Account Management

| Feature | GAQL Query | Description |
|---------|-----------|-------------|
| List child accounts | `SELECT customer_client.id, customer_client.descriptive_name, customer_client.status FROM customer_client WHERE customer_client.manager = false AND customer_client.status = 'ENABLED'` | List all child accounts under MCC |
| Check availability | `SELECT campaign.id FROM campaign WHERE campaign.status != 'REMOVED'` | Check if a CID has active campaigns |

### 4.6 Ad Asset Management

| Feature | API Operation | Description |
|---------|--------------|-------------|
| Sitelinks | `asset_operation.create` + `campaign_asset_operation.create` | Create sitelink assets with link text, final URLs, and descriptions |
| Callouts | Same pattern | Create callout text assets |
| Promotions | Same pattern | Create promotion assets with discount type, amount, occasion |
| Price extensions | Same pattern | Create price assets with product/service pricing |
| Call extensions | Same pattern | Create call assets with phone numbers |
| Structured snippets | Same pattern | Create structured snippet assets with header and values |
| Image assets | `asset_operation.create` (image_asset.data) + `campaign_asset_operation.create` (AD_IMAGE) | Upload and attach image assets |

### 4.7 Data Synchronization

| Feature | Trigger | Description |
|---------|---------|-------------|
| Daily sync | Cron job (automated) | Fetch yesterday's and today's campaign metrics, update campaign statuses and CID availability |
| Manual sync | User-initiated | Sync campaign data for a user-specified date range |
| Full sync | User-initiated | Combine transaction sync and MCC data sync for all accounts |
| Status sync | Cron + on-demand | Refresh campaign enable/pause status from Google Ads |

---

## 5. Authentication and Security

- **Authentication method**: Google Service Account (JWT) with scope `https://www.googleapis.com/auth/adwords`
- **Token management**: Access tokens are requested per API call using service account credentials
- **Headers sent**: `Authorization: Bearer {token}`, `developer-token: {token}`, `login-customer-id: {mcc_id}`
- **Data protection**: All API communication over HTTPS/TLS; platform uses role-based access control, bcrypt password hashing, and httpOnly JWT cookies

---

## 6. User Access and Permissions

The tool implements a role-based access system:

| Role | Access Level | Description |
|------|-------------|-------------|
| Admin | Full access | Can manage all users, system configuration, and view all data |
| Team Leader | Team data access | Can view team members' campaign data and performance reports |
| Team Member | Own data access | Can manage their own campaigns, view own performance data |

**All users are internal employees of Wenzhou Fengdu Advertising & Media Co., Ltd.** No external users, clients, or third parties have access to the tool.

---

## 7. Error Handling

Our tool implements the following error handling for Google Ads API calls:

- **Policy errors**: When a mutate operation fails due to policy violations, the system identifies the violating operations by error index, removes them, and retries the remaining operations
- **Name conflicts**: When a campaign name already exists, the system removes the conflicting campaign and retries
- **Rate limiting**: API calls to multiple CIDs are limited to 5 concurrent requests
- **Authentication errors**: Token refresh is handled automatically; PERMISSION_DENIED errors for disabled accounts are logged and skipped

---

## 8. Data Flow Diagram

```
[Affiliate Networks]  →  [Ad Automation CRM]  ←  [Internal Team Members]
 (CJ, Impact, Awin,        (google-data-            (30+ advertising
  ShareASale, Rakuten)       analysis.top)            professionals)
         ↓                        ↓
  [Merchant Pool]     ┌───────────┴───────────┐
                      ↓                       ↓
            [Google Ads API v23]       [Internal Database]
             - searchStream             - Merchant records
             - mutate                   - Campaign records
                      ↓                 - Daily metrics
            [Google Ads Accounts]       - Commission data
             - Campaigns                - ROI reports
             - Ad Groups / Ads
             - Keywords / Assets
                      ↓
            [Affiliate Merchant Sites]
             (traffic → conversions → commissions)
```

---

## 9. Compliance

- Our use of the Google Ads API complies with the Google Ads API Terms and Conditions
- All Google Ads data accessed through the API is used solely for internal campaign management and reporting
- We do not share, resell, or expose Google Ads data to external parties
- Our Privacy Policy is published at https://google-data-analysis.top/privacy-policy
- Our Terms of Service are published at https://google-data-analysis.top/terms-of-service

---

*End of Design Document*

---

## 四、提交前最终检查清单

提交表单前，逐项确认：

- [ ] API Center 中的联系邮箱已改为 `admin@google-data-analysis.top`
- [ ] API Center 中的公司名称已改为 `Wenzhou Fengdu Advertising & Media Co., Ltd.`
- [ ] API Center 中的公司网址已改为 `https://google-data-analysis.top`
- [ ] MCC 下已关联要管理的 Google Ads 子账户
- [ ] 表单第 3 题填的是企业邮箱，不是个人邮箱
- [ ] 表单第 5 题填的网站能正常访问
- [ ] 网站 About Us 页面能正常打开 (https://google-data-analysis.top/about)
- [ ] 网站 Privacy Policy 能正常打开 (https://google-data-analysis.top/privacy-policy)
- [ ] 网站 Terms of Service 能正常打开 (https://google-data-analysis.top/terms-of-service)
- [ ] 设计文档已导出为 PDF 并准备好上传
- [ ] 表单所有必填项已填写完毕
- [ ] 两个确认框已勾选

---

## 五、历次被驳回的原因与本次修正对照

### 第一次驳回（2026-03 修正）

| 驳回原因 | 具体问题 | 修正内容 |
|---------|---------|---------|
| Identity Verification and Alignment | 使用个人邮箱，无法验证公司关联 | ✅ 改用 admin@google-data-analysis.top 企业邮箱 |
| Identity Verification and Alignment | 网站缺少 About Us、物理地址 | ✅ 已新增 /about 页面含公司全称和地址 |
| Vague Business Model | 工具描述过于简短 | ✅ 提供 7 大功能域详细说明 + 完整设计文档 |
| Vague Business Model | 网站缺少 Privacy Policy / ToS | ✅ 已新增 /privacy-policy 和 /terms-of-service |

### 第二次驳回（2026-04 修正）

| 驳回原因 | 具体问题 | 修正内容 |
|---------|---------|---------|
| Identity Verification and Alignment | 注册联系人信息与商业实体信息不符；仍疑似使用个人/无关邮箱 | ✅ 再次确认 API Center 已改企业邮箱；表单第3题统一使用 admin@google-data-analysis.top |
| Vague Business Model — 描述过短 | 实际提交内容仍类似"内部关键词广告"，未使用完整模板 | ✅ Q6 描述全面重写：明确说明联盟营销（affiliate marketing）业务模式，列出9大功能项 |
| Vague Business Model — 与网站矛盾 | 申请说"内部广告管理工具"，网站展示联盟平台商家管理，审核员判定相矛盾 | ✅ 首页新增英文说明区块；About Us 新增 Business Model 和 How We Use the Google Ads API 章节；申请描述与网站内容完全对齐 |

---

## 六、提交后注意事项

1. **等待时间**：通常 1-3 个工作日会收到回复
2. **邮箱监控**：持续监控 `admin@google-data-analysis.top` 邮箱，Google 可能发补充问题
3. **如被要求补充**：及时回复，不要拖延
4. **如再次被驳回**：保存驳回邮件，分析新的驳回原因后再修正重提
