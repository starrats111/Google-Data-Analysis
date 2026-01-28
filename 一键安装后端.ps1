# 后端一键安装脚本
# 在 PowerShell 中执行：.\一键安装后端.ps1

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "后端安装脚本" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 进入后端目录
cd "D:\Google Analysis\backend"
Write-Host "[1/10] 进入后端目录" -ForegroundColor Yellow

# 创建虚拟环境
if (-not (Test-Path "venv")) {
    Write-Host "[2/10] 创建虚拟环境..." -ForegroundColor Yellow
    python -m venv venv
} else {
    Write-Host "[2/10] 虚拟环境已存在" -ForegroundColor Green
}

# 激活虚拟环境
Write-Host "[3/10] 激活虚拟环境..." -ForegroundColor Yellow
.\venv\Scripts\Activate.ps1

# 升级 pip
Write-Host "[4/10] 升级 pip..." -ForegroundColor Yellow
python -m pip install --upgrade pip --quiet

# 安装基础依赖
Write-Host "[5/10] 安装基础依赖（这可能需要几分钟）..." -ForegroundColor Yellow
pip install fastapi uvicorn sqlalchemy python-jose passlib python-multipart openpyxl python-dotenv

# 安装 pydantic
Write-Host "[6/10] 安装 pydantic..." -ForegroundColor Yellow
pip install pydantic==2.4.2

# 安装 pydantic-settings
Write-Host "[7/10] 安装 pydantic-settings..." -ForegroundColor Yellow
pip install pydantic-settings==2.0.3

# 验证安装
Write-Host "[8/10] 验证安装..." -ForegroundColor Yellow
python -c "import fastapi; print('FastAPI: OK')"
python -c "import sqlalchemy; print('SQLAlchemy: OK')"
python -c "import uvicorn; print('Uvicorn: OK')"
python -c "import pydantic; print('Pydantic: OK')"

# 初始化数据库
Write-Host "[9/10] 初始化数据库..." -ForegroundColor Yellow
python scripts/init_db.py

# 初始化用户
Write-Host "[10/10] 初始化用户..." -ForegroundColor Yellow
python scripts/init_users.py

# 初始化联盟平台
Write-Host "[11/11] 初始化联盟平台..." -ForegroundColor Yellow
python scripts/init_platforms.py

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "安装完成！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "现在启动服务：" -ForegroundColor Yellow
Write-Host "uvicorn app.main:app --reload" -ForegroundColor White
Write-Host ""








