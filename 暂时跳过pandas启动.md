# 暂时跳过 pandas 启动服务

## 问题
numpy 需要编译，但系统缺少 C/C++ 编译器。

## 解决方案：暂时跳过 pandas

数据分析功能需要 pandas，但我们可以先让服务运行起来，测试登录和其他功能。

### 步骤1：安装基础依赖（不包含 pandas）

```powershell
cd "D:\Google Analysis\backend"
.\venv\Scripts\Activate.ps1

pip install fastapi uvicorn[standard] sqlalchemy pydantic pydantic-settings python-jose[cryptography] passlib[bcrypt] python-multipart openpyxl python-dotenv
```

### 步骤2：修改代码，暂时禁用数据分析功能

需要修改 `backend/app/services/analysis_service.py`，在文件开头添加：

```python
try:
    import pandas as pd
    PANDAS_AVAILABLE = True
except ImportError:
    PANDAS_AVAILABLE = False
```

然后在 `process_analysis` 方法中添加检查：

```python
if not PANDAS_AVAILABLE:
    return {
        "status": "failed",
        "error": "pandas 未安装，数据分析功能暂时不可用。请先安装 pandas。"
    }
```

### 步骤3：初始化数据库

```powershell
python scripts/init_db.py
python scripts/init_users.py
python scripts/init_platforms.py
```

### 步骤4：启动服务

```powershell
uvicorn app.main:app --reload
```

## 后续安装 pandas

等服务运行起来后，可以：
1. 安装 Visual Studio Build Tools
2. 或者使用 conda 安装（如果有）
3. 或者使用预编译的 wheel 文件












