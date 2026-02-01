# GitHub推送脚本 (PowerShell)
# 使用方法: .\scripts\push_to_github.ps1 [提交信息]

param(
    [string]$CommitMessage = "更新代码: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
)

Write-Host "=== 推送到GitHub ===" -ForegroundColor Cyan

# 切换到项目根目录
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

Write-Host "`n=== 检查Git状态 ===" -ForegroundColor Yellow
git status

Write-Host "`n=== 添加所有更改 ===" -ForegroundColor Yellow
git add .

Write-Host "`n=== 提交更改 ===" -ForegroundColor Yellow
Write-Host "提交信息: $CommitMessage" -ForegroundColor Gray
git commit -m $CommitMessage

if ($LASTEXITCODE -ne 0) {
    Write-Host "`n警告: 没有需要提交的更改" -ForegroundColor Yellow
    $continue = Read-Host "是否继续推送到远程仓库? (y/n)"
    if ($continue -ne "y") {
        Write-Host "已取消" -ForegroundColor Red
        exit
    }
}

Write-Host "`n=== 推送到GitHub ===" -ForegroundColor Yellow
git push origin main

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n✓ 成功推送到GitHub!" -ForegroundColor Green
    Write-Host "`n=== 后端部署指令 ===" -ForegroundColor Cyan
    Write-Host "请在阿里云服务器上执行以下命令:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "cd ~/Google-Data-Analysis && git pull origin main && cd backend && source venv/bin/activate && pkill -f 'uvicorn.*app.main' && sleep 2 && nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &" -ForegroundColor White
    Write-Host ""
} else {
    Write-Host "`n✗ 推送失败，请检查错误信息" -ForegroundColor Red
    exit 1
}

