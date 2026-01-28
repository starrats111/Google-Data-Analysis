# 启动后端服务
Write-Host "正在启动后端服务..." -ForegroundColor Green
cd backend

# 检查Python
try {
    $pythonVersion = python --version
    Write-Host "Python 版本: $pythonVersion" -ForegroundColor Green
} catch {
    Write-Host "错误: 未找到 Python，请先安装 Python 3.9+" -ForegroundColor Red
    exit 1
}

# 检查虚拟环境
if (-not (Test-Path "venv")) {
    Write-Host "创建虚拟环境..." -ForegroundColor Yellow
    python -m venv venv
}

# 激活虚拟环境
Write-Host "激活虚拟环境..." -ForegroundColor Yellow
.\venv\Scripts\Activate.ps1

# 安装依赖（如果需要）
if (-not (Test-Path "venv\Lib\site-packages\fastapi")) {
    Write-Host "安装依赖..." -ForegroundColor Yellow
    pip install -r requirements.txt
}

# 初始化数据库（首次运行）
if (-not (Test-Path "..\db_initialized.flag")) {
    Write-Host "初始化数据库..." -ForegroundColor Yellow
    python scripts/init_db.py
    python scripts/init_users.py
    python scripts/init_platforms.py
    New-Item -ItemType File -Path "..\db_initialized.flag"
    Write-Host "数据库初始化完成！" -ForegroundColor Green
}

# 启动服务
Write-Host ""
Write-Host "启动后端服务在 http://localhost:8000" -ForegroundColor Green
Write-Host "API文档: http://localhost:8000/docs" -ForegroundColor Cyan
Write-Host ""
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

