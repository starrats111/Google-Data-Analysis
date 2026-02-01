# 快速部署脚本 - 推送代码并显示部署指令
# 使用方法: .\scripts\快速部署.ps1 [提交信息]

param(
    [string]$CommitMessage = "更新代码: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
)

Write-Host "=== 快速部署流程 ===" -ForegroundColor Cyan
Write-Host ""

# 1. 推送到GitHub
Write-Host "步骤1: 推送到GitHub..." -ForegroundColor Yellow
& "$PSScriptRoot\push_to_github.ps1" -CommitMessage $CommitMessage

if ($LASTEXITCODE -ne 0) {
    Write-Host "`n推送失败，请检查错误信息" -ForegroundColor Red
    exit 1
}

Write-Host "`n" -NoNewline
Write-Host ("=" * 60) -ForegroundColor Cyan
Write-Host "=== 后端部署指令（复制以下命令到阿里云服务器执行）===" -ForegroundColor Green
Write-Host ("=" * 60) -ForegroundColor Cyan
Write-Host ""

# 显示完整部署指令
$deployCommand = @"
cd ~/Google-Data-Analysis && git pull origin main && cd backend && source venv/bin/activate && pip install -q --upgrade pip && pip install -q -r requirements.txt && pkill -f 'uvicorn.*app.main' && sleep 2 && nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 & sleep 3 && curl -s http://127.0.0.1:8000/health && echo "" && echo "✓ 部署完成" && tail -n 5 run.log
"@

Write-Host $deployCommand -ForegroundColor White
Write-Host ""

# 显示使用脚本的替代方案
Write-Host ("=" * 60) -ForegroundColor Cyan
Write-Host "=== 或使用部署脚本（推荐）===" -ForegroundColor Green
Write-Host ("=" * 60) -ForegroundColor Cyan
Write-Host ""
Write-Host "cd ~/Google-Data-Analysis/backend && bash scripts/deploy_backend.sh" -ForegroundColor White
Write-Host ""

Write-Host ("=" * 60) -ForegroundColor Cyan
Write-Host "部署指令已复制到剪贴板（如果支持）" -ForegroundColor Green
Write-Host ("=" * 60) -ForegroundColor Cyan

# 尝试复制到剪贴板（Windows）
try {
    $deployCommand | Set-Clipboard
    Write-Host "`n✓ 部署指令已复制到剪贴板" -ForegroundColor Green
} catch {
    Write-Host "`n提示: 可以手动复制上面的命令" -ForegroundColor Yellow
}

