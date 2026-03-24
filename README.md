# Google Analysis CRM

这是一个联盟营销与 Google Ads 管理用的 CRM 系统仓库。

## 当前主系统

正式系统位于 `crm-mvp/`，技术栈如下：

- Next.js 16
- React 19
- Ant Design 6
- Prisma 7
- MySQL / MariaDB
- PM2 + Nginx

## 主要功能

- 用户、团队与权限管理
- 商家管理与商家领取
- Google Ads 广告创建与重发
- 联盟平台账号连接与佣金同步
- 数据中心看板（花费、佣金、MCC 汇总）
- 文章管理与发布
- 系统配置、站点配置与部署配置

## 目录说明

```text
.
├── crm-mvp/                 # CRM 主应用
├── .cursor/rules/           # Cursor 项目规则
├── CRM_MVP_开发文档.md       # CRM 开发文档
└── CRM_MVP_模块与字段.md     # CRM 模块与字段说明
```

## 本地开发

进入 CRM 目录后启动：

```bash
cd crm-mvp
npm install
npm run dev
```

默认本地端口：`20050`

## 生产部署

当前生产环境为腾讯云服务器，使用：

- Nginx 反向代理到 `20050`
- PM2 进程名：`ad-automation`
- GitHub Actions 自动部署

具体部署约束与规则见 `.cursor/rules/deployment.mdc`。
