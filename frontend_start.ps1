# 启动前端服务
Write-Host "正在启动前端服务..." -ForegroundColor Green
cd frontend

# 检查Node.js
try {
    $nodeVersion = node --version
    Write-Host "Node.js 版本: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "错误: 未找到 Node.js，请先安装 Node.js" -ForegroundColor Red
    Write-Host "下载地址: https://nodejs.org/" -ForegroundColor Yellow
    Write-Host "`n安装完成后，请重新运行此脚本" -ForegroundColor Yellow
    pause
    exit 1
}

# 检查npm
try {
    $npmVersion = npm --version
    Write-Host "npm 版本: $npmVersion" -ForegroundColor Green
} catch {
    Write-Host "错误: 未找到 npm" -ForegroundColor Red
    exit 1
}

# 检查依赖
if (-not (Test-Path "node_modules")) {
    Write-Host "`n首次运行，正在安装依赖（这可能需要几分钟）..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "依赖安装失败，请检查网络连接" -ForegroundColor Red
        pause
        exit 1
    }
    Write-Host "依赖安装完成！" -ForegroundColor Green
}

# 启动服务
Write-Host "`n启动前端服务在 http://localhost:3000" -ForegroundColor Green
Write-Host "按 Ctrl+C 停止服务`n" -ForegroundColor Cyan
npm run dev
















