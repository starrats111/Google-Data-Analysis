# 解决 numpy 编译问题

## 问题
安装 pandas 时，numpy 需要编译，但系统缺少 C/C++ 编译器。

## 解决方案

### 方案1：安装预编译的 numpy（推荐）

先安装预编译的 numpy，然后再安装 pandas：

```powershell
pip install numpy
pip install pandas
```

### 方案2：使用旧版本的 pandas（有预编译版本）

```powershell
pip install pandas==2.0.3
```

### 方案3：暂时跳过 pandas（先让服务运行）

如果只是想先让服务运行起来，可以暂时不安装 pandas，稍后再处理数据分析功能。

## 完整安装步骤

在虚拟环境中执行：

```powershell
# 1. 先安装基础依赖（不包含 pandas）
pip install fastapi uvicorn[standard] sqlalchemy pydantic pydantic-settings python-jose[cryptography] passlib[bcrypt] python-multipart openpyxl python-dotenv

# 2. 安装 numpy（预编译版本）
pip install numpy

# 3. 安装 pandas
pip install pandas

# 4. 安装 psycopg2-binary（如果还没有）
pip install psycopg2-binary
```

## 如果仍然失败

可以暂时使用 SQLite 数据库，不需要 psycopg2：

1. 修改 `backend/app/config.py` 中的 `DATABASE_URL` 为 SQLite
2. 暂时跳过 psycopg2-binary 的安装

















