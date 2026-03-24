# CRM MVP

这是当前正在使用的 CRM 主应用。

## 技术栈

- Next.js 16
- React 19
- Ant Design 6
- Prisma 7
- MySQL / MariaDB

## 常用命令

```bash
npm run dev
npm run build
npm run start
npm run seed
```

## 运行说明

### 开发环境

```bash
npm run dev
```

启动后访问：

- `http://localhost:20050`

### 生产环境

```bash
npm run build
npm run start
```

生产环境默认运行在端口 `20050`。

## 核心模块

- `/admin` 管理后台
- `/user` 用户平台
- `prisma/` 数据库模型与迁移
- `src/app/api/` 后端接口
- `src/lib/` 核心业务逻辑

## 说明

如需查看更完整的产品与数据结构说明，请参考仓库根目录：

- `CRM_MVP_开发文档.md`
- `CRM_MVP_模块与字段.md`
