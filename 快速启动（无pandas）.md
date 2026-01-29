# 快速启动指南（暂时跳过 pandas）

## 当前问题
numpy/pandas 需要编译，但系统缺少 C/C++ 编译器。

## 解决方案
暂时跳过 pandas，先让服务运行起来，测试登录和其他功能。

## 启动步骤

### 1. 安装基础依赖（不包含 pandas）

```powershell
cd "D:\Google Analysis\backend"
.\venv\Scripts\Activate.ps1

pip install fastapi uvicorn[standard] sqlalchemy pydantic pydantic-settings python-jose[cryptography] passlib[bcrypt] python-multipart openpyxl python-dotenv
```

### 2. 初始化数据库

```powershell
python scripts/init_db.py
python scripts/init_users.py
python scripts/init_platforms.py
```

### 3. 启动服务

```powershell
uvicorn app.main:app --reload
```

## 可以使用的功能

✅ 用户登录
✅ 联盟账号管理
✅ 文件上传
❌ 数据分析（需要 pandas）
❌ 数据导出（需要 pandas）

## 后续安装 pandas

等基本功能测试通过后，可以：

### 方法1：安装 Visual Studio Build Tools
1. 下载：https://visualstudio.microsoft.com/downloads/
2. 安装 "Desktop development with C++" 工作负载
3. 然后运行：`pip install numpy pandas`

### 方法2：使用预编译的 wheel
尝试从其他源下载预编译的 wheel 文件。

### 方法3：使用 conda（如果有）
```bash
conda install numpy pandas
```

## 现在先测试登录功能

启动服务后：
1. 访问 http://localhost:8000/docs 查看 API 文档
2. 访问 http://localhost:3000 测试登录
3. 使用 manager / manager123 登录











