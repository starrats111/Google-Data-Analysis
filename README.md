# 谷歌广告数据分析平台

## 项目简介

这是一个为广告工作室开发的数据分析平台，用于自动化处理谷歌广告中心和联盟平台的数据分析工作。平台支持数据表格导入、自动分析和可视化展示，大大减少了日常重复性数据搬运工作。

## 功能特性

- ✅ 用户认证系统（1个经理 + 10个员工）
- ✅ 数据表格上传（支持Excel和CSV格式）
- ✅ 自动数据分析（表1 + 表2 → 表3）
- ✅ 数据可视化展示
- ✅ 经理数据总览（查看所有员工数据）
- ✅ 员工个人数据查看
- ✅ 数据字典说明（表4、表5）
- ✅ 多联盟账号管理（每个员工至少3个账号）
- ✅ 多维度数据统计（按平台、账号、员工）
- ✅ 数据导出功能（Excel格式，使用表6模板）⭐

## 技术栈

### 后端
- FastAPI - 现代、快速的Web框架
- PostgreSQL - 关系型数据库
- SQLAlchemy - ORM框架
- Pandas - 数据处理
- JWT - 身份认证

### 前端
- React - UI框架
- Ant Design - UI组件库
- ECharts - 图表库
- Axios - HTTP客户端

### 部署
- Docker & Docker Compose
- Nginx - 反向代理

## 项目结构

```
google-analysis-platform/
├── backend/          # 后端服务
├── frontend/         # 前端应用
├── excel/            # 参考数据表格
├── docker-compose.yml
└── README.md
```

详细的项目结构请参考 [项目框架设计.md](./项目框架设计.md)

## 快速开始

### 前置要求

- Python 3.9+
- Node.js 16+
- Docker & Docker Compose（可选，用于容器化部署）
- PostgreSQL（如果不用Docker）

### 本地开发

#### 1. 克隆项目
```bash
git clone <repository-url>
cd google-analysis-platform
```

#### 2. 后端设置

```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

创建 `.env` 文件：
```env
DATABASE_URL=postgresql://user:password@localhost/google_analysis
SECRET_KEY=your-secret-key-here
UPLOAD_FOLDER=uploads
```

初始化数据库：
```bash
python scripts/init_db.py
python scripts/init_users.py
```

启动后端服务：
```bash
uvicorn app.main:app --reload --port 8000
```

#### 3. 前端设置

```bash
cd frontend
npm install
```

创建 `.env` 文件：
```env
REACT_APP_API_URL=http://localhost:8000
```

启动前端服务：
```bash
npm start
```

#### 4. 访问应用

- 前端: http://localhost:3000
- 后端API: http://localhost:8000
- API文档: http://localhost:8000/docs

### Docker部署

```bash
docker-compose up -d
```

## 默认账户

系统初始化后会创建以下账户：

- **经理账户**: 
  - 用户名: `wenjun123`
  - 密码: `wj123456`

- **员工账户**: 
  - 用户名: `wj01` 到 `wj10`
  - 密码: `wj123456`（所有员工账户密码统一）

**⚠️ 重要**: 首次登录后请立即修改默认密码！

## 使用说明

### 1. 登录系统
使用分配的账户登录系统。

### 2. 上传数据
- 选择数据类型（谷歌广告数据/联盟数据）
- 选择数据日期（前7天内的日期）
- 上传对应的Excel或CSV文件

### 3. 数据分析
- 选择已上传的谷歌广告数据和联盟数据
- 点击"开始分析"按钮
- 系统会自动生成分析结果（表3格式）

### 4. 查看结果
- **员工**: 可以查看自己的分析结果
- **经理**: 可以查看所有员工的数据总览和统计

### 5. 导出数据
- 点击"导出"按钮，将分析结果导出为Excel格式
- 导出文件使用表6的模板格式
- 支持按账号、平台、日期范围筛选后导出
- 导出文件存储在 `excel/` 目录

## 数据表格说明

- **表1**: 谷歌广告中心后台数据
- **表2**: 联盟平台后台数据
- **表3**: 分析效果（由表1和表2自动生成）
- **表4、表5**: 数据字典，说明表3中各字段的含义

## 开发计划

详细的技术实现方案请参考 [技术实现方案.md](./技术实现方案.md)

## 注意事项

1. **数据分析规则**: 需要根据实际的表1、表2、表3结构设计匹配规则
2. **文件大小**: 建议单个文件不超过10MB
3. **数据安全**: 定期备份数据库
4. **性能优化**: 大文件分析建议使用异步任务处理

## 常见问题

### Q: 上传文件失败？
A: 检查文件格式（支持.xlsx, .xls, .csv）和文件大小（不超过10MB）

### Q: 分析结果不正确？
A: 需要检查表1和表2的数据格式是否符合要求，以及匹配规则是否正确

### Q: 如何修改数据分析规则？
A: 修改 `backend/app/services/analysis_service.py` 中的 `_merge_and_analyze` 方法

## 贡献指南

欢迎提交Issue和Pull Request！

## 许可证

MIT License

## 联系方式

如有问题，请联系开发团队。

