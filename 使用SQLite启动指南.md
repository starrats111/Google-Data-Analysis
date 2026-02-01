# 使用 SQLite 启动指南

## 配置已完成

您已经将数据库配置改为 SQLite，这样可以暂时不需要 PostgreSQL。

## 现在可以启动服务了

### 1. 确保虚拟环境已激活

```powershell
cd "D:\Google Analysis\backend"
.\venv\Scripts\Activate.ps1
```

### 2. 安装基础依赖（不需要 psycopg2-binary）

```powershell
pip install fastapi uvicorn[standard] sqlalchemy pydantic pydantic-settings python-jose[cryptography] passlib[bcrypt] python-multipart openpyxl python-dotenv
```

### 3. 安装 numpy 和 pandas（如果还没安装）

```powershell
pip install numpy
pip install pandas==2.0.3
```

### 4. 初始化数据库

```powershell
python scripts/init_db.py
python scripts/init_users.py
python scripts/init_platforms.py
```

### 5. 启动服务

```powershell
uvicorn app.main:app --reload
```

## 启动成功的标志

您会看到：

```
INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
INFO:     Started reloader process
INFO:     Started server process
INFO:     Waiting for application startup.
INFO:     Application startup complete.
```

## 验证

1. 访问 http://localhost:8000/docs - 应该看到 API 文档
2. 然后回到前端登录页面，使用 manager / manager123 登录

## 数据库文件位置

SQLite 数据库文件会创建在：`D:\Google Analysis\backend\google_analysis.db`

## 后续升级到 PostgreSQL

如果以后想使用 PostgreSQL：
1. 安装 PostgreSQL
2. 修改 `config.py` 中的 `DATABASE_URL` 为 PostgreSQL 连接字符串
3. 安装 `psycopg2-binary`
4. 重新初始化数据库















