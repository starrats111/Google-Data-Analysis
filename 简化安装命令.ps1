# 简化安装脚本
# 在 PowerShell 中执行：.\简化安装命令.ps1

Write-Host "开始安装依赖..." -ForegroundColor Green

# 激活虚拟环境
if (Test-Path "venv\Scripts\Activate.ps1") {
    .\venv\Scripts\Activate.ps1
} else {
    Write-Host "创建虚拟环境..." -ForegroundColor Yellow
    python -m venv venv
    .\venv\Scripts\Activate.ps1
}

# 升级 pip
Write-Host "升级 pip..." -ForegroundColor Yellow
python -m pip install --upgrade pip

# 安装依赖（不使用 uvicorn[standard]，避免 watchfiles 问题）
Write-Host "安装基础依赖..." -ForegroundColor Yellow
pip install fastapi uvicorn sqlalchemy pydantic pydantic-settings python-jose passlib python-multipart openpyxl python-dotenv

# 验证安装
Write-Host "`n验证安装..." -ForegroundColor Yellow
python -c "import fastapi; print('FastAPI: OK')"
python -c "import sqlalchemy; print('SQLAlchemy: OK')"
python -c "import uvicorn; print('Uvicorn: OK')"

Write-Host "`n依赖安装完成！" -ForegroundColor Green
Write-Host "`n下一步：初始化数据库" -ForegroundColor Cyan
Write-Host "python scripts/init_db.py" -ForegroundColor White
Write-Host "python scripts/init_users.py" -ForegroundColor White
Write-Host "python scripts/init_platforms.py" -ForegroundColor White
Write-Host "`n然后启动服务：" -ForegroundColor Cyan
Write-Host "uvicorn app.main:app --reload" -ForegroundColor White







