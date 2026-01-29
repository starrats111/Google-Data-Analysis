# 前端一键安装脚本
# 在 PowerShell 中执行：.\一键安装前端.ps1

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "前端安装脚本" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 进入前端目录
cd "D:\Google Analysis\frontend"
Write-Host "[1/3] 进入前端目录" -ForegroundColor Yellow

# 检查 Node.js
try {
    $nodeVersion = node --version
    Write-Host "[2/3] Node.js 版本: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "[错误] 未找到 Node.js，请先安装 Node.js" -ForegroundColor Red
    Write-Host "下载地址: https://nodejs.org/" -ForegroundColor Yellow
    pause
    exit 1
}

# 安装依赖
Write-Host "[3/3] 安装依赖（这可能需要几分钟）..." -ForegroundColor Yellow
npm install

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "安装完成！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "现在启动服务：" -ForegroundColor Yellow
Write-Host "npm run dev" -ForegroundColor White
Write-Host ""












