# 一键推送GitHub脚本 - 自动推送并显示部署指令
# 使用方法: .\scripts\一键推送GitHub.ps1 [提交信息]
# 或者直接双击运行（使用默认提交信息）

param(
    [string]$CommitMessage = "更新代码: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   一键推送GitHub + 自动部署指令" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 切换到项目根目录
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

Write-Host "[1/4] 检查Git状态..." -ForegroundColor Yellow
$status = git status --porcelain
if ($status) {
    Write-Host "发现以下更改:" -ForegroundColor Green
    git status --short
} else {
    Write-Host "没有检测到更改，但继续执行..." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "[2/4] 添加所有更改到暂存区..." -ForegroundColor Yellow
git add .
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ 添加文件失败" -ForegroundColor Red
    exit 1
}
Write-Host "✓ 文件已添加" -ForegroundColor Green

Write-Host ""
Write-Host "[3/4] 提交更改..." -ForegroundColor Yellow
Write-Host "提交信息: $CommitMessage" -ForegroundColor Gray
git commit -m $CommitMessage
if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠ 没有需要提交的更改，但继续推送到远程仓库..." -ForegroundColor Yellow
} else {
    Write-Host "✓ 提交成功" -ForegroundColor Green
}

Write-Host ""
Write-Host "[4/4] 推送到GitHub..." -ForegroundColor Yellow
git push origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ 推送失败，请检查错误信息" -ForegroundColor Red
    Write-Host ""
    Write-Host "常见问题:" -ForegroundColor Yellow
    Write-Host "1. 检查网络连接" -ForegroundColor Gray
    Write-Host "2. 检查GitHub认证（可能需要输入用户名密码或使用SSH密钥）" -ForegroundColor Gray
    Write-Host "3. 检查是否有冲突需要先拉取: git pull origin main" -ForegroundColor Gray
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "✓ 成功推送到GitHub!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

# 显示部署信息
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   部署说明" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "✓ 前端部署: Cloudflare会自动从GitHub拉取最新代码并部署" -ForegroundColor Green
Write-Host "  仓库: https://github.com/starrats111/Google-Data-Analysis" -ForegroundColor Gray
Write-Host "  通常需要1-3分钟完成自动部署" -ForegroundColor Gray
Write-Host ""
Write-Host "⚠ 后端部署: 需要在阿里云服务器手动执行以下命令" -ForegroundColor Yellow
Write-Host ""

# 生成完整的后端部署指令
$deployCommand = "cd ~/Google-Data-Analysis && git pull origin main && cd backend && source venv/bin/activate && pip install -q --upgrade pip && pip install -q -r requirements.txt && pkill -f 'uvicorn.*app.main' && sleep 2 && nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 & sleep 3 && curl -s http://127.0.0.1:8000/health && echo '' && echo '✓ 部署完成' && tail -n 5 run.log"

Write-Host "----------------------------------------" -ForegroundColor Cyan
Write-Host "后端部署指令（复制以下命令）:" -ForegroundColor Yellow
Write-Host "----------------------------------------" -ForegroundColor Cyan
Write-Host ""
Write-Host $deployCommand -ForegroundColor White -BackgroundColor DarkBlue
Write-Host ""

# 生成SSH连接指令
$sshCommand = "ssh admin@iZj6c8iler63a3kzlfi44tZ"
Write-Host "----------------------------------------" -ForegroundColor Cyan
Write-Host "或者使用SSH连接后执行:" -ForegroundColor Yellow
Write-Host "----------------------------------------" -ForegroundColor Cyan
Write-Host ""
Write-Host "1. 先连接服务器:" -ForegroundColor Gray
Write-Host "   $sshCommand" -ForegroundColor White
Write-Host ""
Write-Host "2. 然后执行部署命令:" -ForegroundColor Gray
Write-Host "   $deployCommand" -ForegroundColor White
Write-Host ""

# 尝试复制到剪贴板
try {
    $deployCommand | Set-Clipboard
    Write-Host "----------------------------------------" -ForegroundColor Green
    Write-Host "✓ 部署指令已自动复制到剪贴板！" -ForegroundColor Green
    Write-Host "   可以直接在服务器终端粘贴执行" -ForegroundColor Green
    Write-Host "----------------------------------------" -ForegroundColor Green
} catch {
    Write-Host "提示: 可以手动复制上面的命令" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   完成！" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

