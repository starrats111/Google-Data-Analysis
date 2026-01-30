# 解决 pydantic 安装问题

## 问题
`pydantic-core` 需要 Rust 编译器，但系统没有安装。

## 解决方案

### 方法1：使用旧版本的 pydantic（推荐，有预编译版本）

```powershell
pip install pydantic==2.4.2
pip install pydantic-settings==2.0.3
```

### 方法2：先安装其他依赖，最后安装 pydantic

```powershell
# 先安装不需要编译的包
pip install fastapi uvicorn sqlalchemy python-jose passlib python-multipart openpyxl python-dotenv

# 然后尝试安装 pydantic（使用旧版本）
pip install pydantic==2.4.2 pydantic-settings==2.0.3
```

### 方法3：使用预编译的 wheel 文件

如果方法1和方法2都失败，可以：
1. 从其他已安装 pydantic 的机器复制 wheel 文件
2. 或者使用 conda 安装（如果有）

## 完整安装命令（推荐）

```powershell
cd "D:\Google Analysis\backend"
.\venv\Scripts\Activate.ps1

# 先安装基础包
pip install fastapi uvicorn sqlalchemy python-jose passlib python-multipart openpyxl python-dotenv

# 然后安装旧版本的 pydantic（有预编译版本）
pip install pydantic==2.4.2
pip install pydantic-settings==2.0.3
```

## 验证安装

```powershell
python -c "import pydantic; print('Pydantic: OK')"
python -c "import sqlalchemy; print('SQLAlchemy: OK')"
python -c "import uvicorn; print('Uvicorn: OK')"
```














