# Ad Automation CRM — Google Ads API Tool Design Document

**Company:** Wenzhou Fengdu Advertising & Media Co., Ltd.
**Website:** https://fengdu-ads.top
**Contact:** google-ads-api@fengdu-ads.top
**Date:** May 13, 2026

---

## 1. Company & Tool Overview

Wenzhou Fengdu Advertising & Media Co., Ltd. is an affiliate marketing company based in Wenzhou, Zhejiang, China. Our business model is to drive purchase-intent traffic to partner merchants' websites through Google Search and Performance Max advertising, and we earn commissions on resulting sales.

**Ad Automation CRM** is the in-house tool we built to manage our own Google Ads campaigns programmatically.

- All campaigns operate under **our own** Google Ads Manager (MCC) account
- All advertising budgets are paid for by **our company directly to Google**
- We do **not** manage campaigns on behalf of third-party clients
- The tool is used **exclusively by our internal employees**; not offered as a service or product to any third party
- Deployed on our own infrastructure at https://fengdu-ads.top
- Integrates with **Google Ads API v23** via REST endpoints
- All campaigns comply with Google Ads policies including the **Affiliate Program Policy**

---

## 2. Workflow Diagram

```
┌──────────────────┐    ┌────────────────────┐    ┌──────────────────────┐
│  Schedule trigger │ -> │   Google Ads API   │ -> │  Internal Dashboard  │
│   Daily at 09:00  │    │  Get campaigns      │    │  Update performance  │
│                   │    │  clicks / impr / cost│    │  data & ROI reports  │
└──────────────────┘    └────────────────────┘    └──────────────────────┘
                                  │
                                  v
                        ┌────────────────────┐
                        │   Internal team    │
                        │  reviews & adjusts │
                        │  budgets / bids    │
                        └────────────────────┘
```

---

## 3. Google Ads API Services Used

| Service | Purpose |
|---------|---------|
| **GoogleAdsService** | Search & reporting (GAQL queries via `searchStream`) |
| **CampaignService** | Campaign creation, status, and updates (`mutate`) |
| **BiddingStrategyService** | Bid adjustments and bidding strategy management |
| **KeywordPlanService** | Keyword planning and ideas generation |

---

## 4. Core API Endpoints

Our tool uses two main REST endpoints:

- `POST /customers/{customerId}/googleAds:searchStream` — query campaign data, metrics, account info
- `POST /customers/{customerId}/googleAds:mutate` — create / modify campaigns, ad groups, ads, keywords

---

## 5. Capabilities

### 5.1 Campaign Management
Create and manage Search and Performance Max campaigns, ad groups, Responsive Search Ads, and keywords across our own Google Ads accounts under our MCC.

### 5.2 Performance Reporting
Daily synchronization of metrics (cost, clicks, impressions, average CPC, conversions) using GAQL queries against the `campaign` resource. Reports are aggregated by date and campaign for internal team review and bid/budget optimization.

### 5.3 Keyword Planning
Use Keyword Planner to generate keyword ideas and forecasts for new campaign setup.

---

## 6. Data Flow

```
   Google Ads API  ───>  Ad Automation CRM  ───>  Internal Dashboard
                              │
                              v
                     Internal MySQL Database
                       (campaign records,
                        daily metrics)
```

All data stays within our company's infrastructure. We do not share, resell, or expose Google Ads data to any external party.

---

## 7. Authentication & Security

- **Authentication:** Google Service Account (JWT) with scope `https://www.googleapis.com/auth/adwords`
- **Headers sent:** `Authorization: Bearer {token}`, `developer-token: {token}`, `login-customer-id: {mcc_id}`
- **Transport:** All API communication over HTTPS / TLS
- **Access control:** Role-based access (Admin / Team Leader / Team Member); bcrypt password hashing; httpOnly JWT cookies

---

## 8. User Access

All users of this tool are internal employees of Wenzhou Fengdu Advertising & Media Co., Ltd. **No external users, clients, or third parties have access.**

| Role | Access Level |
|------|-------------|
| Admin | Full system access |
| Team Leader | Team-level campaign data |
| Team Member | Own campaigns only |

---

## 9. Compliance

- Use of Google Ads API complies with the **Google Ads API Terms and Conditions**
- Our affiliate marketing campaigns comply with the **Google Ads Affiliate Program Policy**
- Google Ads data is used **solely for internal campaign management and reporting**
- We do not share, resell, or expose Google Ads data to external parties
- Privacy Policy: https://fengdu-ads.top/privacy-policy
- Terms of Service: https://fengdu-ads.top/terms-of-service

---

*End of Design Document*
